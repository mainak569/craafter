import { Sandbox } from "@e2b/code-interpreter";
import { AgentResult, Message, TextMessage } from "@inngest/agent-kit";
import { posix } from "path";
import { z } from "zod";
import { SANDBOX_TIMEOUT } from "./types";
import {
  acceptanceCheckScript,
  autoFixScript,
  listFilesScript,
  smokeTestScript,
  syntaxCheckScript,
  type AcceptanceCheck,
} from "./sandbox-scripts";

export async function getSandbox(sandboxId: string) {
  const sandbox = await Sandbox.connect(sandboxId);
  await sandbox.setTimeout(SANDBOX_TIMEOUT);
  return sandbox;
}

// Models sometimes send multi-line tool arguments JSON-escaped a second time
// (a literal \n and \" instead of a newline and a quote)
const unescapeText = (text: string) =>
  text
    // a backslash before a real line break: half-unescaped "\\n"
    .replace(/\\\r?\n/g, "\n")
    .replace(/\\(n|t|"|\\)/g, (_, char: string) => ({ n: "\n", t: "\t", '"': '"', "\\": "\\" })[char] ?? char);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Replaces the one place oldText appears in content. Tries it as written, then
// unescaped, then with any whitespace allowed where it has whitespace (models
// often get indentation slightly wrong). Never guesses between several places.
function applyEdit(content: string, oldText: string, newText: string, unescape: boolean):
  { content: string } | { error: string } {
  const attempts: [string, string][] = unescape
    ? [[oldText, unescapeText(newText)], [unescapeText(oldText), unescapeText(newText)]]
    : [[oldText, newText]];
  if (!unescape && unescapeText(oldText) !== oldText) attempts.push([unescapeText(oldText), unescapeText(newText)]);

  let found = 0;
  for (const [from, to] of attempts) {
    if (!from.trim()) continue;
    const count = content.split(from).length - 1;
    if (count === 1) return { content: content.replace(from, () => to) };
    found = Math.max(found, count);
  }
  for (const [from, to] of attempts) {
    if (!from.trim()) continue;
    const pattern = new RegExp(from.trim().split(/\s+/).map(escapeRegExp).join("\\s+"), "g");
    const matches = [...content.matchAll(pattern)];
    if (matches.length === 1) {
      const [match] = matches;
      return { content: content.slice(0, match.index) + to.trim() + content.slice(match.index + match[0].length) };
    }
    found = Math.max(found, matches.length);
  }
  return { error: found > 1 ? `appears ${found} times` : "isn't in the file" };
}

// Applies edits in order. With unescape, every replacement is unescaped too
// (for when the model double-escaped it but the snippet still matched as written).
export function applyEdits(
  content: string,
  edits: { oldText: string; newText: string }[],
  { unescape = false } = {},
): { content: string } | { error: string } {
  for (const [i, { oldText, newText }] of edits.entries()) {
    const edited = applyEdit(content, oldText, newText, unescape);
    if ("error" in edited) {
      return { error: `Edit ${i + 1}: oldText ${edited.error}` };
    }
    content = edited.content;
  }
  return { content };
}

// Syntax errors in content for the file at path, or "" if it parses. JSON is
// checked here, code with the sandbox's TypeScript (nothing is written).
export async function checkFileSyntax(sandbox: Sandbox, path: string, content: string) {
  if (path.endsWith(".json")) {
    try {
      JSON.parse(content);
      return "";
    } catch (error) {
      return `${path}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (!/\.[jt]sx?$/.test(path)) {
    return "";
  }
  return await runNodeScript(sandbox, syntaxCheckScript([[path.replace(/^\/home\/user\//, ""), content]]), 30_000);
}

type Dependencies = { [name: string]: string };

const readDependencies = (packageJson: string) => {
  const pkg = JSON.parse(packageJson);
  return {
    dependencies: (pkg.dependencies ?? {}) as Dependencies,
    devDependencies: (pkg.devDependencies ?? {}) as Dependencies,
  };
};

// Whether the agent added, removed or changed packages compared to the template
export function packagesChanged(templatePackageJson: string, packageJson: string) {
  const before = readDependencies(templatePackageJson);
  const after = readDependencies(packageJson);
  const same = (a: Dependencies, b: Dependencies) =>
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([name, version]) => b[name] === version);
  return !same(before.dependencies, after.dependencies) ||
    !same(before.devDependencies, after.devDependencies);
}

// Installs the packages from a saved package.json that the sandbox lacks
export async function installMissingPackages(sandbox: Sandbox, packageJson: string) {
  const wanted = readDependencies(packageJson);
  const installed = readDependencies(await sandbox.files.read("package.json"));
  for (const kind of ["dependencies", "devDependencies"] as const) {
    const missing = Object.entries(wanted[kind])
      .filter(([name, version]) => installed[kind][name] !== version)
      // Only plain names and versions go into the command line
      .filter(([name, version]) => /^[@\w./-]+$/.test(name) && /^[\w.^~<>=|:/@ -]+$/.test(version))
      .map(([name, version]) => `'${name}@${version}'`);
    if (missing.length === 0) continue;

    const flag = kind === "devDependencies" ? " --save-dev" : "";
    await sandbox.commands
      .run(`npm install --no-audit --no-fund${flag} ${missing.join(" ")}`, {
        cwd: "/home/user",
        timeoutMs: 300_000,
      })
      // The app check reports whatever is still missing, and the agent installs it
      .catch((error) => console.error("Restoring packages failed:", error));
  }
}

// Written into every sandbox as instrumentation-client.ts, which Next.js runs in
// the browser before the app. Forwards errors that only happen there (clicks,
// effects, async code) to the editor that embeds the preview.
export const ERROR_REPORTER_SOURCE = `// Managed by Craafter: reports preview errors to the editor. Do not edit.
const report = (message: string, stack?: string) => {
  if (window.parent === window) return;
  window.parent.postMessage(
    { type: "craafter:runtime-error", message, stack, path: location.pathname },
    "*",
  );
};
window.addEventListener("error", (event) => report(event.message, event.error?.stack));
window.addEventListener("unhandledrejection", (event) =>
  report(String(event.reason?.message ?? event.reason), event.reason?.stack),
);
`;

// Runs a Node.js script in the sandbox. Passed inline: the sandbox's /tmp doesn't
// let the file API overwrite a file, and inline code can't break shell quoting.
async function runNodeScript(sandbox: Sandbox, source: string, timeoutMs: number) {
  const script = Buffer.from(source).toString("base64");
  const result = await sandbox.commands.run(
    // oom_score_adj: if memory runs out, the kernel kills this script (and the
    // browser it starts) instead of the dev server that serves the preview
    `echo 1000 > /proc/self/oom_score_adj; node -e "$(echo ${script} | base64 -d)" || true`,
    { cwd: "/home/user", timeoutMs },
  );
  return result.stdout.trim();
}

interface BrowserError {
  path: string;
  steps: string[];
  message: string;
  stack: string;
}

const decodeHtmlEntities = (text: string) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

// URL paths of the pages among the given files: app/about/page.tsx -> /about.
// Dynamic segments get a placeholder value, so those pages may 404.
const pageRoutes = (files: string[]) => {
  const routes = new Map<string, Omit<PageRoute, "path">>([["/", { dynamic: false, pattern: "^/$" }]]);
  for (const file of files) {
    const dir = file.match(/^(?:src\/)?app\/(.*?)\/?page\.[jt]sx?$/)?.[1];
    if (dir === undefined) continue;
    // route groups "(marketing)" and parallel routes "@modal" aren't in the URL
    const segments = dir.split("/").filter((seg) => seg && !/^\(.*\)$/.test(seg) && !seg.startsWith("@"));
    const dynamic = segments.some((seg) => seg.startsWith("["));
    const pattern = "^/" + segments
      .map((seg) => (seg.startsWith("[...") || seg.startsWith("[[...") ? ".+" : seg.startsWith("[") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/") + "$";
    routes.set("/" + segments.map((seg) => (seg.startsWith("[") ? "1" : seg)).join("/"), { dynamic, file, pattern });
  }
  return [...routes].slice(0, 10).map(([path, route]) => ({ path, ...route }));
};

export interface PageRoute {
  path: string;
  dynamic: boolean;
  file?: string;
  // Matches the page's URLs, e.g. ^/blog/[^/]+$ for app/blog/[id]/page.tsx
  pattern: string;
}

export interface ServerCheck {
  errors: string | null;
  // The pages for the browser check, when the app renders
  routes: PageRoute[];
}

// Checks every page of the app in the sandbox as the server renders it, and
// parses the app's files. The browser check (getBrowserErrors) runs separately,
// in its own step, since it needs most of a step's time limit.
export async function getServerErrors(sandboxId: string): Promise<ServerCheck> {
  const sandbox = await getSandbox(sandboxId);
  const fetchPage = async (path: string) => {
    const result = await sandbox.commands.run(
      `curl -s -o /tmp/check.html -w '%{http_code}' --max-time 90 'http://localhost:3000${path}' || true`,
      { timeoutMs: 120_000 },
    );
    return result.stdout.trim();
  };

  if (await fetchPage("/") === "000") {
    // Nothing listening: the dev server died (e.g. out of memory). Start it again
    // as the template does, since the preview needs it too.
    await sandbox.commands.run("npx next dev --turbopack", {
      background: true,
      cwd: "/home/user",
    });
    await sandbox.commands.run(
      "for i in $(seq 1 45); do curl -s -o /dev/null http://localhost:3000 && break; sleep 2; done",
      { timeoutMs: 120_000 },
    );
    if (await fetchPage("/") === "000") {
      console.warn(`Couldn't check sandbox ${sandboxId}: dev server not responding`);
      return { errors: null, routes: [] };
    }
  }

  let files: string[] = [];
  try {
    files = JSON.parse(await runNodeScript(sandbox, listFilesScript, 30_000));
  } catch {}
  const routes = pageRoutes(files);

  const errors: string[] = [];
  const seenDetails = new Set<string>();
  for (const { path, dynamic, file } of routes) {
    const status = await fetchPage(path);
    if (status === "200" || (dynamic && status === "404")) continue;

    const page = file ? `${path} (${file})` : path;
    const details = await readNextError(sandbox);
    // A broken shared component fails every page with the same error
    if (details && seenDetails.has(details)) {
      errors.push(`GET ${page} returned HTTP ${status} (same error as above).`);
      continue;
    }
    if (details) seenDetails.add(details);
    errors.push([`GET ${page} returned HTTP ${status}.`, details].filter(Boolean).join("\n\n"));
  }

  // The dev server can report a syntax error far from its cause; the parser
  // pinpoints it. Also catches broken files no page imports.
  const syntax = files.length > 0 ? await runNodeScript(sandbox, syntaxCheckScript(files), 60_000) : "";
  if (syntax) errors.push(`Syntax errors:\n${syntax}`);

  if (errors.length === 0) {
    return { errors: null, routes };
  }
  return { errors: await withFileContents(sandbox, errors.join("\n\n")), routes };
}

// Time the browser check may take, within the 300s a step gets on Vercel
const BROWSER_CHECK_BUDGET_MS = 240_000;

// Tests the app in headless Chromium: first the agent's acceptance checks, then
// the smoke test (see sandbox-scripts.ts). Returns null if nothing goes wrong
// (or it can't be checked), otherwise the problems, each with the steps that
// lead to it.
export interface BrowserCheck {
  errors: string | null;
  // Acceptance checks that pass whatever their steps do (for the checks review)
  weakChecks: string[];
  // Acceptance checks that failed, with how many expectations each has, and
  // every check's count: to notice a failing check being weakened instead of fixed
  failingChecks: { [name: string]: number };
  checkExpectations: { [name: string]: number };
  // What each checked page shows on a fresh load
  initialText: { [page: string]: string };
}

export async function getBrowserErrors(sandboxId: string, routes: PageRoute[]): Promise<BrowserCheck> {
  const sandbox = await getSandbox(sandboxId);
  const started = Date.now();
  // The stack traces only name compiled chunks, so point to the page's source file
  const pageWithFile = (path: string) => {
    const file = routes.find((route) => new RegExp(route.pattern).test(path))?.file;
    return file ? `${path} (${file}, or a component it imports)` : path;
  };

  const { problems, weakChecks, failingChecks, checkExpectations, initialText } =
    await getAcceptanceProblems(sandbox, ACCEPTANCE_CHECK_BUDGET_MS, pageWithFile);

  // Pages with a placeholder id would just 404; the browser finds real ids by
  // following the app's links
  const paths = routes.filter((route) => !route.dynamic).map((route) => route.path);
  const smokeBudget = Math.max(BROWSER_CHECK_BUDGET_MS - (Date.now() - started), 30_000);
  const result = parseScriptResult<BrowserError[]>(
    await runNodeScript(sandbox, smokeTestScript(paths, smokeBudget), smokeBudget + 45_000),
    "Smoke test",
  );

  // The same bug often fires on every click or page; report it once
  const seen = new Set<string>();
  for (const error of (result ?? []).filter((error) => !seen.has(error.message) && seen.add(error.message)).slice(0, 8)) {
    const steps = error.steps.map((step, i) => `${i + 1}. ${step}`).join("\n");
    // The usual cause, and fix, of a hydration mismatch in these apps
    const hint = /Hydration failed|didn't match the client/.test(error.message)
      ? "\nIn these apps this almost always comes from reading localStorage (or Date.now(), Math.random(), window) while rendering, e.g. in a useState initializer. " +
        "Fix: start with the same default state on the server and in the browser, and load saved data in a useEffect after the first render."
      : "";
    problems.push(`In the browser on ${pageWithFile(error.path)}, after these steps:\n${steps}\n\n${error.message.split("\n")[0]}${hint}${error.stack ? `\n${error.stack}` : ""}`);
  }

  const checks = { weakChecks, failingChecks, checkExpectations, initialText };
  if (problems.length === 0) {
    return { errors: null, ...checks };
  }
  return { errors: await withFileContents(sandbox, problems.join("\n\n")), ...checks };
}

// The last line a script prints is its JSON result. Returns null (and logs why)
// when it has none, e.g. in a sandbox from a template without the browser: a
// check that can't run is skipped rather than failing the generation.
function parseScriptResult<T>(output: string, name: string): T | null {
  try {
    const result = JSON.parse(output.split("\n").pop() || "");
    if (result && typeof result === "object" && "failed" in result && !Array.isArray(result)) {
      console.warn(`${name} failed:`, result.failed);
      return null;
    }
    return result as T;
  } catch {
    console.warn(`${name} gave no result:`, output.slice(-500));
    return null;
  }
}

// The agent's acceptance checks: what the app should do, written as steps a
// person would take (see the prompt). They catch wrong results that don't look
// wrong, which the smoke test can't.
export const CHECKS_FILE = "craafter.checks.json";
const ACCEPTANCE_CHECK_BUDGET_MS = 90_000;

const checksSchema = z.array(z.object({
  name: z.string().min(1),
  page: z.string().startsWith("/"),
  steps: z.array(z.union([
    z.object({ fill: z.string(), value: z.string() }).strict(),
    z.object({ click: z.string() }).strict(),
    z.object({ select: z.string(), option: z.string() }).strict(),
    z.object({ press: z.string() }).strict(),
    z.object({ expectText: z.string() }).strict(),
    z.object({ expectNoText: z.string() }).strict(),
  ])).min(1),
})).max(30);

interface AcceptanceFailure {
  name: string;
  page: string;
  step: number | null;
  stepText: string | null;
  reason: string;
  shown: string;
}

async function getAcceptanceProblems(
  sandbox: Sandbox,
  budgetMs: number,
  pageWithFile: (path: string) => string,
): Promise<{
  problems: string[];
  weakChecks: string[];
  failingChecks: { [name: string]: number };
  checkExpectations: { [name: string]: number };
  initialText: { [page: string]: string };
}> {
  const none = { weakChecks: [], failingChecks: {}, checkExpectations: {}, initialText: {} };
  const raw = await sandbox.files.read(`/home/user/${CHECKS_FILE}`).catch(() => null);
  if (raw === null) {
    return { problems: [`There's no ${CHECKS_FILE}. Add acceptance checks for the app's main features, as described in your instructions.`], ...none };
  }

  let checks: AcceptanceCheck[];
  try {
    checks = checksSchema.parse(JSON.parse(raw));
  } catch (error) {
    const reason = error instanceof z.ZodError
      ? error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      : String(error);
    return { problems: [`${CHECKS_FILE} isn't valid (${reason}). Fix it to match the format in your instructions.`], ...none };
  }
  if (checks.length === 0) {
    return { problems: [`${CHECKS_FILE} has no checks. Add checks for the app's main features.`], ...none };
  }

  const result = parseScriptResult<{
    passed: number;
    failures: AcceptanceFailure[];
    weak: string[];
    expectations: { name: string; count: number }[];
    initialText: { [page: string]: string };
  }>(
    await runNodeScript(sandbox, acceptanceCheckScript(checks, budgetMs), budgetMs + 45_000),
    "Acceptance checks",
  );
  const problems = (result?.failures ?? []).slice(0, 6).map((failure) => {
    const where = failure.step ? ` at step ${failure.step} ${failure.stepText}` : "";
    return `Acceptance check "${failure.name}" (${CHECKS_FILE}) fails on ${pageWithFile(failure.page)}${where}: ${failure.reason}.\n` +
      `The page shows: "${failure.shown}"\n` +
      "Either the app doesn't do what the check describes (fix the app), or the check is wrong about how the app is meant to work, " +
      "e.g. it forgot the app's sample data (fix the check). Don't change a check just to accept a wrong result.";
  });
  const checkExpectations = Object.fromEntries((result?.expectations ?? []).map((check) => [check.name, check.count]));
  const failingChecks = Object.fromEntries((result?.failures ?? []).map((failure) => [failure.name, checkExpectations[failure.name] ?? 0]));
  return { problems, weakChecks: result?.weak ?? [], failingChecks, checkExpectations, initialText: result?.initialText ?? {} };
}

export interface AutoFix {
  fixes: string[];
  // New contents of the files it changed
  files: { [path: string]: string };
}

// Fixes mechanical mistakes (missing imports, "use client", packages) without
// the model: see autoFixScript. errors are the latest check's, if any.
export async function autoFix(sandboxId: string, errors = ""): Promise<AutoFix> {
  const sandbox = await getSandbox(sandboxId);
  let files: string[] = [];
  try {
    files = JSON.parse(await runNodeScript(sandbox, listFilesScript, 30_000));
  } catch {}
  const result = parseScriptResult<{ fixes: string[]; changed: { [path: string]: string }; install: string[] }>(
    await runNodeScript(sandbox, autoFixScript(errors, files), 30_000),
    "Auto-fix",
  );
  if (!result) {
    return { fixes: [], files: {} };
  }

  const fixes = [...result.fixes];
  if (result.install.length > 0) {
    const install = await sandbox.commands.run(
      `npm install --no-audit --no-fund ${result.install.map((name) => `'${name}'`).join(" ")}`,
      { cwd: "/home/user", timeoutMs: 300_000 },
    ).catch((error) => error);
    if (install?.exitCode === 0) fixes.push(`installed ${result.install.join(", ")}`);
  }
  return { fixes, files: result.changed };
}

// Appends the files that the errors name, so fixing them doesn't cost the agent
// a round trip (and a model request) to read them first
async function withFileContents(sandbox: Sandbox, errors: string) {
  const paths = new Set<string>();
  for (const match of errors.matchAll(/(?:^|[\s(./])((?:src\/)?(?:app|components|lib|hooks)\/[\w\-./[\]()@]+\.[jt]sx?|craafter\.checks\.json)/g)) {
    if (!match[1].startsWith("components/ui/")) paths.add(match[1]);
  }

  const contents: string[] = [];
  let size = 0;
  const add = async (path: string) => {
    const content = await sandbox.files.read(`/home/user/${path}`).catch(() => null);
    if (content === null || size + content.length > 40_000) return null;
    size += content.length;
    contents.push(`=== ${path} ===\n${content}`);
    return content;
  };

  const named = [...paths].slice(0, 4);
  const imported = new Set<string>();
  for (const path of named) {
    const content = await add(path);
    // The bug is often in a file the page imports (e.g. lib/tip.ts), so include
    // the app's own files it imports too
    for (const match of content?.matchAll(/from\s+["'](\.{1,2}\/[^"']+|@\/[^"']+)["']/g) ?? []) {
      const spec = match[1];
      const base = spec.startsWith("@/")
        ? spec.slice(2)
        : posix.normalize(posix.join(posix.dirname(path), spec));
      if (base.startsWith("components/ui/")) continue;
      imported.add(base);
    }
  }
  for (const base of [...imported].slice(0, 4)) {
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      if (paths.has(candidate) || !/\.[jt]sx?$/.test(candidate)) continue;
      if (await add(candidate) !== null) {
        paths.add(candidate);
        break;
      }
    }
  }

  const text = errors.replace(/\x1b\[[0-9;]*m/g, "");
  if (contents.length === 0) {
    return text;
  }
  return `${text}\n\nCurrent contents of the files named above (no need to read them again):\n\n${contents.join("\n\n")}`;
}

// Next.js puts compile errors in the error page's __NEXT_DATA__, and render
// errors in data-next-error-* attributes
async function readNextError(sandbox: Sandbox) {
  const html = await sandbox.files.read("/tmp/check.html").catch(() => "");
  const details: string[] = [];
  const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (nextData) {
    try {
      const message = JSON.parse(nextData).err?.message;
      if (message) details.push(message);
    } catch {}
  }
  const renderError = html.match(/data-next-error-stack="([^"]*)"/)?.[1]
    ?? html.match(/data-next-error-message="([^"]*)"/)?.[1];
  if (renderError) {
    details.push(decodeHtmlEntities(renderError).split("\n").slice(0, 6).join("\n"));
  }
  return details.join("\n\n");
}

export function lastAssistantTextMessageContent(result: AgentResult) {
  const lastAssistantTextMessageIndex = result.output.findLastIndex(
    (message) => message.role === "assistant"
  );

  const message = result.output[lastAssistantTextMessageIndex] as
    | TextMessage
    | undefined;

  return message?.content
    ? typeof message.content === "string"
      ? message.content
      : message.content.map((c) => c.text).join("")
    : undefined;
}

export const parseAgentOutput = (value: Message[], fallback: string) => {
    const output = value[0];
    if (!output || output.type !== "text") {
        return fallback;
    }

    if (Array.isArray(output.content)) {
        return output.content.map((txt) => txt).join("");
    } else {
        return output.content;
    }
};