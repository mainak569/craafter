// Node.js scripts that run inside the sandbox (see runNodeScript in utils.ts).
// Plain JavaScript in String.raw templates, so they read as written; each
// __PLACEHOLDER__ is filled in with JSON by the function that returns the script.

const fill = (script: string, values: Record<string, unknown>) =>
  script.replace(/__([A-Z]+)__/g, (placeholder, key: string) =>
    key in values ? JSON.stringify(values[key]) : placeholder,
  );

// Lists the app's source files and pages (paths relative to /home/user),
// whoever wrote them: the agent, a restored version, or a terminal command.
export const listFilesScript = String.raw`
const fs = require("fs");
const path = require("path");
const skip = new Set(["node_modules", ".next", "components/ui", "public"]);
const found = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.name.startsWith(".") || skip.has(rel)) continue;
    if (entry.isDirectory()) walk(rel);
    else if (/\.[jt]sx?$/.test(entry.name)) found.push(rel);
  }
};
for (const dir of ["app", "src", "components", "lib", "hooks"]) {
  if (fs.existsSync(dir)) walk(dir);
}
console.log(JSON.stringify(found.slice(0, 300)));
`;

// Parses the given files with the sandbox's TypeScript and prints syntax errors.
// Parse-only on purpose: a full type check is slow and memory hungry, and the
// template's own shadcn files have type errors that don't break the app.
// Each entry is a path, or [path, content] to check content that isn't written yet.
export const syntaxCheckScript = (files: (string | [string, string])[]) => fill(String.raw`
const ts = require("/home/user/node_modules/typescript");
const fs = require("fs");
for (const entry of __FILES__) {
  const [file, source] = Array.isArray(entry) ? entry : [entry, fs.readFileSync(entry, "utf8")];
  const { diagnostics } = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve },
  });
  for (const d of diagnostics.slice(0, 10)) {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    console.log(file + "(" + (line + 1) + "," + (character + 1) + "): " + ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  }
}
`, { FILES: files });

// Uses each page like a (very impatient) person would, in headless Chromium
// (installed in the sandbox template), and prints the problems this causes as
// JSON, each with the steps that led to it. Catches what server rendering can't:
// broken click handlers, effects and async code. Per page:
// 1. clicks every control once (and picks an option in menus and listboxes)
// 2. drags each draggable item onto another
// 3. picks every option of native selects
// 4. types edge-case values into inputs and submits them
// 5. does 40 seeded random actions, for bugs that need a sequence of steps
// Throughout, it follows the app's links to more pages (up to 10, which covers
// dynamic routes with real ids), and also reports text that signals a wrong
// result (NaN, undefined, [object Object], Invalid Date), failed requests to
// the app and broken links.
export const smokeTestScript = (routes: string[], budgetMs: number) => fill(String.raw`
process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/playwright";
const { chromium } = require("/opt/smoke/node_modules/playwright-core");
const routes = __ROUTES__;
const deadline = Date.now() + __BUDGET__;
const PAGE_BUDGET = 45000;
const MAX_PAGES = 10;
const ORIGIN = "http://localhost:3000";

const CLICKABLE = 'button, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="combobox"], [role="menuitem"], [role="option"], input[type="checkbox"], input[type="radio"]';
const OPTIONS = '[role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
const TEXT_INPUTS = 'input:not([type]), input[type="text"], input[type="email"], input[type="search"], input[type="number"], input[type="url"], input[type="tel"], input[type="date"], textarea';
const DRAGGABLE = '[draggable="true"], [aria-roledescription="draggable"], [aria-roledescription="sortable"], [data-rfd-drag-handle-draggable-id], [data-rbd-drag-handle-draggable-id]';
// Values that commonly break apps: empty, zero, negative, huge, markup and quotes, very long
const EDGE_VALUES = ["", "0", "-1", "999999999", "Test <b>&\"'", "x".repeat(300)];

(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  // A real browser lets a page use the clipboard after a click; headless doesn't
  // unless asked, which would make "Copy" buttons look broken
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept().catch(() => {}));
  const errors = [];
  let current = "/";
  let trail = [];
  const reported = new Set();
  // key: report a problem once, e.g. the same NaN after every click
  const report = (message, stack = "", key = message) => {
    if (reported.has(key)) return;
    reported.add(key);
    errors.push({ path: current, steps: trail.slice(-6), message, stack });
  };
  page.on("pageerror", (error) => {
    if (/ResizeObserver loop/.test(error.message)) return;
    // The app's own frames: React's and Next.js's don't help fix anything
    const stack = (error.stack || "").split("\n").slice(1)
      .filter((line) => !/node_modules|<anonymous>/.test(line)).slice(0, 4).join("\n");
    errors.push({ path: current, steps: trail.slice(-6), message: error.message, stack });
  });
  // The app's own requests that fail (a fetch to a missing route, a missing image)
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== ORIGIN || response.status() < 400 || response.request().resourceType() === "document") return;
    if (/^\/(_next|__nextjs)/.test(url.pathname) || url.pathname === "/favicon.ico") return;
    report("A request to " + url.pathname + " failed with HTTP " + response.status(), "", "request " + url.pathname);
  });

  // Wrong results often show up as these in the page text
  const checkShown = async () => {
    const found = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : "";
      const first = {};
      for (const match of text.matchAll(/(^|[^A-Za-z])(NaN|undefined|\[object Object\]|Invalid Date)(?![A-Za-z])/g)) {
        const at = match.index + match[1].length;
        first[match[2]] ??= text.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, " ").trim();
      }
      return Object.entries(first);
    }).catch(() => []);
    for (const [value, context] of found) {
      report('The page shows "' + value + '", in: "' + context + '"', "", current + " shows " + value);
    }
  };

  // Marks the index-th visible, enabled element matching selector (light DOM only,
  // so Next.js's dev overlay in its shadow root is skipped) and returns its label.
  // Inside an open dialog only the dialog is usable, so only it is searched.
  const mark = (selector, index, attr = "data-smoke") =>
    page.evaluate(([selector, index, attr]) => {
      document.querySelectorAll("[" + attr + "]").forEach((el) => el.removeAttribute(attr));
      const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter((el) => el.getClientRects().length > 0);
      const root = dialogs[dialogs.length - 1] || document;
      const els = [...root.querySelectorAll(selector)].filter(
        (el) => el.getClientRects().length > 0 && !el.disabled && el.getAttribute("aria-disabled") !== "true",
      );
      if (index === "count") return els.length;
      const el = els[index];
      if (!el) return null;
      el.setAttribute(attr, "");
      const label = el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
        el.getAttribute("title") || el.getAttribute("name") || el.tagName.toLowerCase();
      return label.trim().replace(/\s+/g, " ").slice(0, 40);
    }, [selector, index, attr]).catch(() => null);

  const settle = async () => {
    await page.waitForTimeout(350);
    await checkShown();
  };
  const errorCount = () => errors.length;

  // Pages to test: the given ones, then pages linked from them (which covers
  // dynamic routes like /blog/[id] with real ids), up to MAX_PAGES
  const queue = routes.map((path) => ({ path }));
  const queued = new Set(routes);

  // Returns the page's HTTP status
  const open = async (path) => {
    trail = ["loading the page"];
    const response = await page.goto(ORIGIN + path, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(1000);
    await checkShown();
    return response ? response.status() : 0;
  };

  const queueLinks = async () => {
    const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => [
      a.href,
      (a.innerText || a.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 30),
    ])).catch(() => []);
    for (const [href, text] of links) {
      const url = new URL(href);
      // Other sites, Next.js internals and files (/logo.png) aren't pages
      if (url.origin !== ORIGIN || /^\/(_next|api)\b/.test(url.pathname) || /\.\w+$/.test(url.pathname)) continue;
      if (queued.has(url.pathname) || queue.length >= MAX_PAGES) continue;
      queued.add(url.pathname);
      queue.push({ path: url.pathname, from: current, text });
    }
  };

  // Fills empty inputs so "Add"-style buttons have something to work with
  const fillEmptyInputs = async () => {
    const inputs = page.locator(TEXT_INPUTS);
    for (let i = 0; i < Math.min(await inputs.count(), 10); i++) {
      const input = inputs.nth(i);
      if (!(await input.isVisible().catch(() => false)) || !(await input.isEditable().catch(() => false))) continue;
      if (await input.inputValue().catch(() => "x")) continue;
      const type = await input.getAttribute("type");
      const value = type === "number" ? "5" : type === "email" ? "test@example.com" : type === "date" ? "2026-01-15" : type === "url" ? "https://example.com" : "Test item";
      await input.fill(value, { timeout: 1000 }).catch(() => {});
    }
  };

  const click = async (selector, index) => {
    const label = await mark(selector, index);
    if (label === null) return false;
    trail.push('clicking "' + label + '"');
    await page.click("[data-smoke]", { timeout: 2000, noWaitAfter: true }).catch(() => {});
    await settle();
    return true;
  };

  const type = async (index, value) => {
    const label = await mark(TEXT_INPUTS, index);
    if (label === null) return false;
    const input = page.locator("[data-smoke]");
    const shown = value.length > 20 ? value.slice(0, 12) + "... (" + value.length + " chars)" : value;
    trail.push('typing "' + shown + '" into "' + label + '"');
    const inputType = await input.getAttribute("type").catch(() => null);
    // Number and date inputs only accept their own formats
    if (inputType === "number" && !/^-?\d*$/.test(value)) value = "0";
    if (inputType === "date") value = value ? "2026-02-30" : "";
    await input.fill(value, { timeout: 1000 }).catch(() => {});
    return true;
  };

  const pressEnter = async () => {
    trail.push("pressing Enter");
    await page.keyboard.press("Enter").catch(() => {});
    await settle();
  };

  // Drags the index-th draggable onto another one, preferring one in a different
  // list (e.g. another kanban column), with small mouse steps so pointer-based
  // libraries (dnd-kit, react-beautiful-dnd) and native drag and drop both react.
  const drag = async (index) => {
    const pair = await page.evaluate(([selector, index]) => {
      document.querySelectorAll("[data-smoke-src], [data-smoke-dst]").forEach((el) => {
        el.removeAttribute("data-smoke-src");
        el.removeAttribute("data-smoke-dst");
      });
      const els = [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0);
      const src = els[index];
      if (!src || els.length < 2) return null;
      const others = els.filter((el) => el !== src);
      const dst = others.find((el) => el.parentElement !== src.parentElement && !el.contains(src) && !src.contains(el)) || others[0];
      src.setAttribute("data-smoke-src", "");
      dst.setAttribute("data-smoke-dst", "");
      const name = (el) => (el.innerText || el.getAttribute("aria-label") || "item").trim().replace(/\s+/g, " ").slice(0, 30);
      return [name(src), name(dst)];
    }, [DRAGGABLE, index]).catch(() => null);
    if (!pair) return false;
    trail.push('dragging "' + pair[0] + '" onto "' + pair[1] + '"');
    try {
      const from = await page.locator("[data-smoke-src]").boundingBox();
      const to = await page.locator("[data-smoke-dst]").boundingBox();
      if (!from || !to) return true;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 8, { steps: 4 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
      await page.waitForTimeout(150);
      await page.mouse.up();
    } catch {}
    await settle();
    return true;
  };

  // Starts the page over after an error (the dev overlay covers it) or after
  // navigating away. Returns false if the page can't be loaded any more.
  const recover = async (path, before) => {
    if (errorCount() === before && new URL(page.url()).pathname === path) return true;
    try {
      await open(path);
      return true;
    } catch {
      return false;
    }
  };

  for (let r = 0; r < queue.length && Date.now() < deadline; r++) {
    const { path, from, text } = queue[r];
    const routeDeadline = Math.min(deadline, Date.now() + PAGE_BUDGET, Date.now() + (deadline - Date.now()) / (queue.length - r));
    const inTime = () => Date.now() < routeDeadline;
    current = path;
    let status;
    try { status = await open(path); } catch { continue; }
    if (status >= 400) {
      if (from) report('The link "' + text + '" on ' + from + " goes to " + path + ", which returns HTTP " + status);
      // Pages given to check that fail on the server were already reported
      continue;
    }
    await queueLinks();

    // 1. Every control once, picking an option when it opens a menu or listbox
    await fillEmptyInputs();
    for (let i = 0; i < 30 && inTime(); i++) {
      const before = errorCount();
      if (!(await click(CLICKABLE, i))) break;
      const options = await mark(OPTIONS, "count");
      if (options > 0) await click(OPTIONS, options - 1);
      await page.keyboard.press("Escape").catch(() => {});
      if (!(await recover(path, before))) break;
      if (errorCount() > before) await fillEmptyInputs();
    }

    // 2. Drag and drop
    for (let i = 0; i < 6 && inTime(); i++) {
      const before = errorCount();
      if (!(await drag(i))) break;
      if (!(await recover(path, before))) break;
    }

    // 3. Every option of native selects
    const selects = page.locator("select");
    for (let s = 0; s < Math.min(await selects.count().catch(() => 0), 5) && inTime(); s++) {
      const select = selects.nth(s);
      const values = await select.locator("option").evaluateAll((els) => els.map((el) => el.value)).catch(() => []);
      const name = (await select.getAttribute("aria-label").catch(() => null)) || (await select.getAttribute("name").catch(() => null)) || "select";
      for (const value of values.slice(0, 8)) {
        const before = errorCount();
        trail.push('choosing "' + value + '" in "' + name + '"');
        await select.selectOption(value, { timeout: 1000 }).catch(() => {});
        await settle();
        if (!(await recover(path, before))) break;
      }
    }

    // 4. Edge-case values in each input, submitted with Enter and with the button
    //    that belongs to it (the first button after the input in the page)
    const inputCount = (await mark(TEXT_INPUTS, "count")) || 0;
    for (let i = 0; i < Math.min(inputCount, 5) && inTime(); i++) {
      for (const value of EDGE_VALUES) {
        if (!inTime()) break;
        const before = errorCount();
        if (!(await type(i, value))) break;
        await pressEnter();
        if (errorCount() === before) {
          const label = await page.evaluate(() => {
            const input = document.querySelector("[data-smoke]");
            if (!input) return null;
            const buttons = [...document.querySelectorAll("button")].filter(
              (b) => b.getClientRects().length > 0 && !b.disabled &&
                input.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
            );
            if (!buttons[0]) return null;
            buttons[0].setAttribute("data-smoke-btn", "");
            return (buttons[0].innerText || buttons[0].getAttribute("aria-label") || "button").trim().slice(0, 40);
          }).catch(() => null);
          if (label) {
            trail.push('clicking "' + label + '"');
            await page.click("[data-smoke-btn]", { timeout: 2000, noWaitAfter: true }).catch(() => {});
            await page.evaluate(() => document.querySelectorAll("[data-smoke-btn]").forEach((el) => el.removeAttribute("data-smoke-btn"))).catch(() => {});
            await settle();
          }
        }
        if (!(await recover(path, before))) break;
      }
    }

    // 5. Random sequences, for bugs that need several steps in some order.
    //    Seeded, so a run can be repeated exactly.
    let seed = 42 + r;
    const random = () => {
      // mulberry32
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    try { await open(path); } catch { continue; }
    for (let step = 0; step < 40 && inTime(); step++) {
      const before = errorCount();
      const roll = random();
      if (roll < 0.6) {
        const count = await mark(CLICKABLE, "count");
        if (count) await click(CLICKABLE, Math.floor(random() * count));
      } else if (roll < 0.8) {
        const count = await mark(TEXT_INPUTS, "count");
        if (count) {
          const pool = ["Test item", "Another one", "5", ...EDGE_VALUES];
          await type(Math.floor(random() * count), pool[Math.floor(random() * pool.length)]);
          if (random() < 0.5) await pressEnter();
        }
      } else if (roll < 0.9) {
        const count = await page.locator(DRAGGABLE).count().catch(() => 0);
        if (count > 1) await drag(Math.floor(random() * count));
      } else {
        trail.push("pressing Escape");
        await page.keyboard.press("Escape").catch(() => {});
      }
      if (!(await recover(path, before))) break;
    }
  }

  await browser.close();
  console.log(JSON.stringify(errors));
})().catch((error) => console.log(JSON.stringify({ failed: String(error) })));
`, { ROUTES: routes, BUDGET: budgetMs });

export type AcceptanceStep =
  | { fill: string; value: string }
  | { click: string }
  | { select: string; option: string }
  | { press: string }
  | { expectText: string }
  | { expectNoText: string };

export interface AcceptanceCheck {
  name: string;
  page: string;
  steps: AcceptanceStep[];
}

// Runs the app's acceptance checks (craafter.checks.json, written by the agent)
// in headless Chromium, each in a fresh browser context, and prints
// { passed, failures, weak } as JSON. These catch wrong results that don't look wrong,
// e.g. a 15% tip on $40 shown as $0.60.
export const acceptanceCheckScript = (checks: AcceptanceCheck[], budgetMs: number) => fill(String.raw`
process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/playwright";
const { chromium } = require("/opt/smoke/node_modules/playwright-core");
const checks = __CHECKS__;
const deadline = Date.now() + __BUDGET__;
const ORIGIN = "http://localhost:3000";

// Finds a control the way a person would describe it: by its accessible name
// or label, and only if no control matches, by plain text (which also matches
// headings, like a dialog titled the same as its button)
const control = (page, name) => [
  page.getByRole("button", { name })
    .or(page.getByRole("link", { name }))
    .or(page.getByRole("tab", { name }))
    .or(page.getByRole("checkbox", { name }))
    .or(page.getByRole("switch", { name }))
    .or(page.getByRole("menuitem", { name }))
    .or(page.getByRole("option", { name }))
    .or(page.getByLabel(name))
    .or(page.getByPlaceholder(name)),
  page.getByText(name, { exact: true }),
];

const describe = (step) => JSON.stringify(step);

// Lines of the page that share the most words with the expected text: a check
// often has the right value in slightly different words ("4 remaining" vs
// "4 tasks remaining"), which the whole page text can hide
const closestText = (page, expected) => page.evaluate((expected) => {
  const words = (text) => new Set(text.toLowerCase().match(/[a-z0-9$%.]+/g) || []);
  const wanted = words(expected);
  const lines = (document.body ? document.body.innerText : "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines
    .map((line) => ({ line, score: [...words(line)].filter((word) => wanted.has(word)).length }))
    .filter((entry) => entry.score > 0 && entry.line.length <= 120)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.line);
}, expected).catch(() => []);

// What the page offers instead, when a step can't find its control, so the agent
// can tell a wrong name in the check from a control with no name (an icon-only
// button needs an aria-label to be found, by this and by screen readers)
const available = (page, step) => page.evaluate((kind) => {
  const visible = (el) => el.getClientRects().length > 0;
  const nameOf = (el) => (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "").trim().replace(/\s+/g, " ");
  if (kind === "fill") {
    const fields = [...document.querySelectorAll("input, textarea")].filter(visible).map((el) => {
      const label = el.labels && el.labels[0] ? el.labels[0].innerText : "";
      return (el.getAttribute("aria-label") || label || el.getAttribute("placeholder") || "").trim();
    });
    return "Fields on the page: " + (fields.filter(Boolean).map((name) => JSON.stringify(name)).join(", ") || "none") +
      (fields.some((name) => !name) ? " (and " + fields.filter((name) => !name).length + " without a label or placeholder)" : "");
  }
  const controls = [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="option"]')].filter(visible);
  const named = [...new Set(controls.map(nameOf).filter(Boolean))].slice(0, 25);
  const unnamed = controls.filter((el) => !nameOf(el)).length;
  return "Buttons and links on the page: " + (named.map((name) => JSON.stringify(name.slice(0, 40))).join(", ") || "none") +
    (unnamed ? " (and " + unnamed + " without a name, e.g. icon-only: give them an aria-label)" : "");
}, "fill" in step ? "fill" : "click").catch(() => "");

// The match a person would use when several have the same name: visible (not
// a hidden mobile copy) and on top at its position (the dialog's "Create"
// button, not the one behind the dialog's overlay that opened it)
// Takes a locator or a list of them in order of preference.
const pick = async (locators) => {
  const list = [].concat(locators);
  let fallback = null;
  for (const locator of list) {
    const visible = locator.filter({ visible: true });
    const count = await visible.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const onTop = await visible.nth(i).evaluate((el) => {
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return Boolean(hit) && (el === hit || el.contains(hit));
      }).catch(() => false);
      if (onTop) return visible.nth(i);
    }
    if (count > 0 && !fallback) fallback = visible.first();
  }
  return fallback || list[0].first();
};

const runStep = async (page, step) => {
  if ("fill" in step) {
    const field = await pick(page.getByLabel(step.fill).or(page.getByPlaceholder(step.fill)));
    await field.fill(step.value, { timeout: 3000 });
  } else if ("click" in step) {
    await (await pick(control(page, step.click))).click({ timeout: 3000 });
  } else if ("select" in step) {
    const field = await pick(page.getByLabel(step.select).or(page.getByRole("combobox", { name: step.select })));
    const tag = await field.evaluate((el) => el.tagName.toLowerCase(), undefined, { timeout: 3000 });
    if (tag === "select") {
      await field.selectOption({ label: step.option }, { timeout: 3000 });
    } else {
      await field.click({ timeout: 3000 });
      await (await pick(page.getByRole("option", { name: step.option }))).click({ timeout: 3000 });
    }
  } else if ("press" in step) {
    await page.keyboard.press(step.press);
  } else if ("expectText" in step) {
    await page.getByText(step.expectText).first().waitFor({ state: "visible", timeout: 3000 })
      .catch(async () => {
        const closest = await closestText(page, step.expectText);
        throw new Error('the text "' + step.expectText + '" isn\'t on the page' +
          (closest.length > 0 ? ". Closest text on the page: " + closest.map((line) => JSON.stringify(line)).join(", ") : ""));
      });
  } else if ("expectNoText" in step) {
    await page.waitForTimeout(500);
    if (await page.getByText(step.expectNoText).first().isVisible().catch(() => false)) {
      throw new Error('the text "' + step.expectNoText + '" is still on the page');
    }
  } else {
    throw new Error("unknown step type");
  }
  await page.waitForTimeout(300);
};

(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const failures = [];
  const weak = [];
  // What each page shows on a fresh load (for the checks review: sample data
  // the app starts with changes what counts and totals should be)
  const initialText = {};
  let passed = 0;
  for (const check of checks) {
    if (Date.now() > deadline) break;
    // A fresh context per check: no localStorage or cookies left by other checks
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    page.on("dialog", (dialog) => dialog.accept().catch(() => {}));
    let thrown = null;
    page.on("pageerror", (error) => { thrown = thrown || error.message; });
    let failed = null;
    let at = 0;
    try {
      const response = await page.goto(ORIGIN + check.page, { waitUntil: "load", timeout: 60000 });
      await page.waitForTimeout(800);
      if (response && response.status() >= 400) throw new Error("the page returns HTTP " + response.status());
      if (!(check.page in initialText)) {
        initialText[check.page] = (await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => ""))
          .replace(/\s+/g, " ").trim().slice(0, 1000);
      }
      // A check whose expected text is all on the page before its steps run
      // passes whatever the steps do, so it proves nothing
      const expectations = check.steps.filter((step) => "expectText" in step || "expectNoText" in step);
      const acts = check.steps.some((step) => !("expectText" in step || "expectNoText" in step));
      if (acts && expectations.length > 0 && expectations.every((step) => "expectText" in step)) {
        let already = true;
        for (const step of expectations) {
          if (!(await page.getByText(step.expectText).first().isVisible().catch(() => false))) { already = false; break; }
        }
        if (already) weak.push(check.name);
      }
      for (at = 0; at < check.steps.length; at++) {
        await runStep(page, check.steps[at]);
        if (thrown) throw new Error("the app threw: " + thrown);
      }
    } catch (error) {
      let reason = String(error.message || error).split("\n")[0];
      if (/Timeout .*exceeded/.test(reason)) {
        const step = check.steps[at] || {};
        reason = "couldn't find or use that control on the page";
        if ("fill" in step || "click" in step || "select" in step) reason += ". " + (await available(page, step));
      }
      const shown = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
      failed = {
        name: check.name,
        page: check.page,
        step: at < check.steps.length ? at + 1 : null,
        stepText: at < check.steps.length ? describe(check.steps[at]) : null,
        reason,
        shown: shown.replace(/\s+/g, " ").trim().slice(0, 500),
      };
    }
    if (failed) failures.push(failed); else passed++;
    await context.close();
  }
  await browser.close();
  const expectations = checks.map((check) => ({
    name: check.name,
    count: check.steps.filter((step) => "expectText" in step || "expectNoText" in step).length,
  }));
  console.log(JSON.stringify({ passed, failures, weak, expectations, initialText }));
})().catch((error) => console.log(JSON.stringify({ failed: String(error) })));
`, { CHECKS: checks, BUDGET: budgetMs });

// Fixes mechanical mistakes without the model, in every app file: missing
// imports (React hooks, Next.js, shadcn components, lucide icons, cn), a missing
// "use client", and packages that are imported but not installed (returned for
// the caller to install). Prints { fixes, changed, install } as JSON. errors is
// the latest check's output, for names it reports as not defined.
export const autoFixScript = (errors: string, files: string[]) => fill(String.raw`
const fs = require("fs");
const errors = __ERRORS__;
const files = __FILES__;

const fixes = [];
const changed = {};
const install = new Set();
const read = (file) => changed[file] ?? fs.readFileSync(file, "utf8");
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// Adds a line after the "use client" directive (which must stay first), or at the top
const addLine = (src, line) => {
  const lines = src.split("\n");
  const at = /^\s*["']use client["'];?\s*$/.test(lines[0] || "") ? 1 : 0;
  lines.splice(at, 0, line);
  return lines.join("\n");
};

// 1. Names used without an import: "useState is not defined", "Button is not defined"
const REACT = ["useState", "useEffect", "useMemo", "useCallback", "useRef", "useReducer", "useContext",
  "createContext", "useId", "useTransition", "useLayoutEffect", "useDeferredValue", "startTransition",
  "Fragment", "forwardRef", "memo", "Suspense"];
const NEXT = {
  Link: ["next/link", true], Image: ["next/image", true],
  useRouter: ["next/navigation"], usePathname: ["next/navigation"], useSearchParams: ["next/navigation"],
  useParams: ["next/navigation"], notFound: ["next/navigation"], redirect: ["next/navigation"],
};
const ui = {};
for (const file of fs.existsSync("components/ui") ? fs.readdirSync("components/ui") : []) {
  const src = fs.readFileSync("components/ui/" + file, "utf8");
  const module = "@/components/ui/" + file.replace(/\.tsx?$/, "");
  for (const match of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) ui[name] = module;
    }
  }
  for (const match of src.matchAll(/export\s+(?:function|const)\s+([A-Za-z_$][\w$]*)/g)) ui[match[1]] = module;
}
let lucide = {};
try { lucide = require("/home/user/node_modules/lucide-react"); } catch {}

const sourceOf = (name) => {
  if (REACT.includes(name)) return ["react", false];
  if (NEXT[name]) return [NEXT[name][0], Boolean(NEXT[name][1])];
  if (name === "cn") return ["@/lib/utils", false];
  if (ui[name]) return [ui[name], false];
  if (/^[A-Z]/.test(name) && lucide[name]) return ["lucide-react", false];
  return null;
};

// Names from the errors, plus what each file visibly uses: JSX components (not
// TypeScript generics like useState<Item>, hence nothing word-like before "<"),
// hook calls and cn(). Checked before errors show up too, since Next.js only
// reports the first one per page.
const undefinedNames = new Set();
for (const match of errors.matchAll(/\b([A-Za-z_$][\w$]*) is not defined/g)) undefinedNames.add(match[1]);
for (const file of files) {
  const code = withoutComments(read(file));
  const names = new Set(undefinedNames);
  for (const match of code.matchAll(/(^|[^\w$.])<([A-Z][\w$]*)(?=[\s/>])/g)) names.add(match[2]);
  // (optionally with type arguments: useState<string[]>(...))
  for (const match of code.matchAll(/(^|[^\w$.])(use[A-Z][\w$]*)\s*(<[^()]*>)?\s*\(/g)) names.add(match[2]);
  if (/(^|[^\w$.])cn\(/.test(code)) names.add("cn");
  for (const name of names) {
    const source = sourceOf(name);
    if (!source) continue;
    const src = read(file);
    const used = new RegExp("(^|[^\\w$.])" + name + "\\b");
    const declared = new RegExp("(import[^;]*\\b" + name + "\\b[^;]*from)|((const|let|var|function|class|interface|type|enum)\\s+" + name + "\\b)|([{,]\\s*" + name + "\\s*[,}=:])");
    if (!used.test(withoutComments(src)) || declared.test(src)) continue;
    const [module, isDefault] = source;
    const line = isDefault ? "import " + name + ' from "' + module + '";' : "import { " + name + ' } from "' + module + '";';
    changed[file] = addLine(src, line);
    fixes.push("added " + line + " to " + file);
  }
}

// 2. Hooks or event handlers in a component that isn't a client component
// (Every file that calls a hook or passes an event handler needs it anyway)
{
  for (const file of files) {
    // Only components: a hooks or utility module works without it
    if (!/\.[jt]sx$/.test(file)) continue;
    const src = read(file);
    if (/^\s*["']use client["']/.test(src)) continue;
    const clientOnly = /\buse(State|Effect|Reducer|Ref|Context|Memo|Callback|LayoutEffect|Router|Pathname|SearchParams)\s*(<[^()]*>)?\s*\(|\son[A-Z]\w*=\{/.test(withoutComments(src));
    // Server-only features would break as a client component
    const serverOnly = /export\s+(const\s+metadata|async\s+function|default\s+async)/.test(src);
    if (!clientOnly || serverOnly) continue;
    changed[file] = '"use client";\n\n' + src;
    fixes.push('added "use client" to ' + file);
  }
}

// 3. Packages the app imports but that aren't installed
const specs = [...errors.matchAll(/Can't resolve '([^']+)'/g)].map((match) => match[1]);
for (const file of files) {
  for (const match of withoutComments(read(file)).matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) specs.push(match[1]);
}
const builtins = new Set(require("module").builtinModules);
for (const spec of specs) {
  if (builtins.has(spec) || spec.startsWith("node:")) continue;
  if (/^(\.|@\/|\/)/.test(spec)) continue;
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name) && !fs.existsSync("node_modules/" + name)) install.add(name);
}

for (const [file, content] of Object.entries(changed)) fs.writeFileSync(file, content);
console.log(JSON.stringify({ fixes, changed, install: [...install] }));
`, { ERRORS: errors, FILES: files });
