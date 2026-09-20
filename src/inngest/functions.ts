import { Sandbox } from "@e2b/code-interpreter"
import {
    createAgent,
    createTool,
    createNetwork,
    type Tool,
    type Message,
    createState,
  } from "@inngest/agent-kit";

import { inngest } from "./client";
import { applyEdits, autoFix, checkFileSyntax, CHECKS_FILE, ERROR_REPORTER_SOURCE, getBrowserErrors, getSandbox, getServerErrors, installMissingPackages, lastAssistantTextMessageContent, packagesChanged, parseAgentOutput } from "./utils";
import z from "zod";
import { CHECKS_REVIEW_PROMPT, FRAGMENT_TITLE_PROMPT, PROMPT, RESPONSE_PROMPT } from "@/prompt";
import prisma from "@/lib/db";
import { refundCredits } from "@/lib/usage";
import { SANDBOX_TIMEOUT } from "./types";
import {
    createModel,
    fallbackProvider,
    isCoolingDown,
    isQuotaError,
    modelName,
    roleUsesFallback,
    startCooldown,
    type ModelRole,
    type Provider,
} from "./models";

// How many times the agent is sent back to fix errors the app check finds. Each
// round costs a few model requests; 0 turns fixing off (errors are still reported).
const fixAttemptsSetting = Number.parseInt(process.env.CODE_AGENT_FIX_ATTEMPTS ?? "", 10);
const MAX_FIX_ATTEMPTS = fixAttemptsSetting >= 0 ? fixAttemptsSetting : 3;

// The agent is told to use paths like "app/page.tsx", but may add "./" or "/home/user/"
const normalizePath = (path: string) => path.replace(/^\.\//, "").replace(/^\/home\/user\//, "");

interface AgentState {
  summary: string;
  files: { [path: string]: string };
  // Errors the app still has after the agent used up its fix attempts
  appErrors?: string;
};

export const codeAgentFunction = inngest.createFunction(
  {
    id: "code-agent",
    // Runs once all retries are exhausted, so the UI shows an error instead of
    // loading forever, and the user gets their credit back.
    onFailure: async ({ event, error, step }) => {
      const { projectId } = event.data.event.data;
      console.error(`code-agent failed for project ${projectId}:`, error);

      await step.run("save-failure", async () => {
        const project = await prisma.project.findUnique({
          where: { id: projectId },
        });
        if (!project) return;

        await prisma.project.update({ where: { id: projectId }, data: { status: null } }).catch(() => {});
        await prisma.message.create({
          data: {
            projectId,
            content: isQuotaError(error)
              ? "The AI model is out of quota right now, so I couldn't finish. Your credit was refunded — please try again later."
              : "Something went wrong while generating. Your credit was refunded, please try again.",
            role: "ASSISTANT",
            type: "ERROR",
          },
        });
        await refundCredits(project.userId);
      });
    },
  },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    // What the project page shows while this runs (see MessageLoading)
    const setStatus = async (status: string | null) => {
        await prisma.project
            .update({ where: { id: event.data.projectId }, data: { status } })
            .catch(() => {});
    };
    await setStatus("Starting up the sandbox");

    // Gemini unless it recently ran out of quota, and then only for the work the
    // fallback can actually take (see src/inngest/models.ts)
    let geminiExhausted = await step.run("check-provider-cooldown", () => isCoolingDown("gemini"));
    const providerFor = (role: ModelRole): Provider =>
        geminiExhausted && fallbackProvider && roleUsesFallback(role) ? fallbackProvider : "gemini";
    let provider = providerFor("code");

    const sandboxId = await step.run("get-sandbox-id", async () => {
        // craafter-nextjs-v3 adds a headless browser (for getBrowserErrors) and 2 GB RAM
        // to craafter-nextjs-test-2; see sandbox-templates/nextjs
        const sandbox = await Sandbox.create("craafter-nextjs-v3");
        await sandbox.setTimeout(SANDBOX_TIMEOUT);
        // Forwards browser errors in the preview to the editor (see FragmentWeb)
        await sandbox.files.write("instrumentation-client.ts", ERROR_REPORTER_SOURCE);
        return sandbox.sandboxId;
    });

    // Each run gets a fresh sandbox, so load the latest version of the app into
    // it. Otherwise follow-ups ("make the button blue") would start from scratch.
    const { previousFiles, templatePackageJson } = await step.run("restore-files", async () => {
        const fragment = await prisma.fragment.findFirst({
            where: { message: { projectId: event.data.projectId } },
            orderBy: { createdAt: "desc" },
        });
        const files = (fragment?.files ?? {}) as { [path: string]: string };
        const sandbox = await getSandbox(sandboxId);
        const templatePackageJson = await sandbox.files.read("package.json");
        for (const [path, content] of Object.entries(files)) {
            // Saved when the app added packages; installed below instead of copied
            if (path === "package.json") continue;
            await sandbox.files.write(path, content);
        }
        if (files["package.json"]) {
            await installMissingPackages(sandbox, files["package.json"]);
        }
        return { previousFiles: files, templatePackageJson };
    });

    const previousMessages = await step.run("get-previous-messages", async () => {
        const formattedMessages: Message[] = [];

        const messages = await prisma.message.findMany({
            where: {
            projectId: event.data.projectId,
            // error messages ("Something went wrong...") are not useful context
            type: "RESULT",
            },
            orderBy: {
            createdAt: "desc",
            },
            // the newest message is the current prompt, which network.run() already sends
            skip: 1,
            take: 5,
        });

        for (const message of messages) {
            formattedMessages.push({
            type: "text",
            role: message.role === "ASSISTANT" ? "assistant" : "user",
            content: message.content,
            });
        }

        formattedMessages.reverse(); // Reverse to maintain chronological order

        if (Object.keys(previousFiles).length > 0) {
            formattedMessages.push({
                type: "text",
                role: "user",
                content: `This is a follow-up request: the sandbox already contains the app built so far. Make only the change asked for (see "Follow-up requests"), reading the files you need before editing them. Files: ${Object.keys(previousFiles).join(", ")}`,
            });
        }
        return formattedMessages;
    });

    const state = createState<AgentState>(
        {
            summary: "",
            files: previousFiles,
        },
        {
            messages: previousMessages,
        }
    );

    let fixAttempts = 0;
    // Set while the agent fixes errors the check found: the summary it wrote
    // before, and the errors of the latest check
    let pendingSummary: string | null = null;
    let lastErrors: string | null = null;
    // Whether the agent may have changed the app since the last check: the
    // check takes a minute or two, so an unchanged app isn't checked again
    let changedSinceCheck = true;
    let checksReviewed = false;
    // Acceptance checks reported as failing, with their expectation counts
    const reportedFailing: { [name: string]: number } = {};
    // How bad the app is at each check (lower is better): 3 doesn't render,
    // 2 fails in the browser or its acceptance checks, 1 only the checks review
    // has findings, 0 passes. The best version seen is kept to fall back to.
    let latestScore = 0;
    let best: { score: number; files: { [path: string]: string }; errors: string | null } | null = null;

    const makeChecksReviewer = () => createAgent({
        name: "checks-reviewer",
        description: "Reviews the acceptance checks against the user's requests",
        system: CHECKS_REVIEW_PROMPT,
        model: createModel(providerFor("review"), "review", 0),
    });

    // Checks the agent's acceptance checks against what the user asked for: a
    // feature without a check, or a check expecting the wrong result, would let
    // a wrong app pass. One request to the cheaper summary model, once per run.
    const reviewChecks = async (weakChecks: string[], initialText: { [page: string]: string }) => {
        const checks = await step.run("read-checks", async () => {
            const sandbox = await getSandbox(sandboxId);
            return await sandbox.files.read(`/home/user/${CHECKS_FILE}`).catch(() => null);
        });
        if (!checks) return null;

        const requests = [
            ...previousMessages
                .filter((message) => message.type === "text" && message.role === "user")
                .map((message) => (message.type === "text" && typeof message.content === "string" ? message.content : ""))
                .filter((text) => text && !text.startsWith("This is a follow-up request")),
            event.data.value as string,
        ];
        const { output } = await makeChecksReviewer().run(
            `The user's requests, oldest first:\n${requests.map((text, i) => `${i + 1}. ${text}`).join("\n")}\n\n` +
            `${CHECKS_FILE}:\n${checks}\n\n` +
            `What each page shows on a fresh load, before any step:\n${Object.entries(initialText).map(([page, text]) => `${page}: "${text}"`).join("\n") || "(unknown)"}\n\n` +
            `Checks whose expected text is already on the page before their steps run: ${weakChecks.length > 0 ? weakChecks.join(", ") : "none"}`,
        );

        let review: { missing?: unknown; wrong?: unknown };
        try {
            // The reply is JSON, sometimes wrapped in a code fence or a sentence
            const reply = parseAgentOutput(output, "{}");
            review = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
        } catch {
            return null;
        }
        const missing = (Array.isArray(review.missing) ? review.missing : []).filter((item): item is string => typeof item === "string").slice(0, 5);
        const normalize = (text: unknown) => String(text ?? "").toLowerCase().replace(/[^a-z0-9$%.]+/g, " ").trim();
        const wrong = (Array.isArray(review.wrong) ? review.wrong : [])
            .filter((item): item is { check: string; why: string; expects?: string; shouldExpect?: string } =>
                typeof item?.check === "string" && typeof item?.why === "string")
            // The summary model sometimes works out a check is right and still
            // lists it: drop findings where the fix would change nothing
            .filter((item) => !item.shouldExpect || normalize(item.expects) !== normalize(item.shouldExpect))
            .slice(0, 5);
        const findings = [
            ...(missing.length > 0 ? [`Things the user asked for that no check covers: ${missing.join("; ")}. Add checks for them.`] : []),
            ...wrong.map((item) => `Check "${item.check}" looks wrong: ${item.why}${item.shouldExpect ? ` (expected: "${item.shouldExpect}")` : ""}. Fix the check, or the app if the check is right.`),
        ];
        if (findings.length === 0) return null;
        return `A review of the acceptance checks (${CHECKS_FILE}) against the user's requests found:\n` +
            `${findings.map((finding) => `- ${finding}`).join("\n")}\n\nCurrent ${CHECKS_FILE}:\n${checks}`;
    };

    // Checks the app, fixing mechanical mistakes without the model first. Returns
    // the problems left for the agent, or null.
    const checkApp = async (network: { state: { data: AgentState } }) => {
        if (!changedSinceCheck) {
            return lastErrors;
        }
        await setStatus("Checking the app renders");
        const applyAutoFix = async (errors?: string) => {
            const fixed = await step.run("auto-fix", () => autoFix(sandboxId, errors));
            if (fixed.fixes.length > 0) {
                network.state.data.files = { ...network.state.data.files, ...fixed.files };
            }
            return fixed.fixes.length > 0;
        };

        await applyAutoFix();
        let server = await step.run("check-app", () => getServerErrors(sandboxId));
        // A fix can reveal the next error (Next.js reports one per page at a time)
        for (let round = 0; server.errors && round < 2; round++) {
            if (!(await applyAutoFix(server.errors))) break;
            server = await step.run("check-app", () => getServerErrors(sandboxId));
        }

        let score = 0;
        if (server.errors) {
            lastErrors = server.errors;
            score = 3;
        } else {
            // Only use an app in the browser once it renders: otherwise that just
            // repeats the errors above
            await setStatus("Testing the app in a browser");
            const browser = await step.run("check-app-in-browser", () =>
                getBrowserErrors(sandboxId, server.routes),
            );
            // A failing check that loses expectations or disappears was weakened
            // to pass, rather than the app fixed
            const weakened = Object.entries(reportedFailing)
                .filter(([name, count]) => (browser.checkExpectations[name] ?? 0) < count)
                .map(([name]) => name);
            Object.assign(reportedFailing, browser.failingChecks);
            const guard = weakened.length > 0
                ? `The acceptance checks ${weakened.map((name) => `"${name}"`).join(", ")} failed and then lost expectations or were removed. ` +
                  `Restore what they checked: fix the app, or correct the expected text to what the app shows when it works as the user asked (e.g. the exact wording), but don't delete it.`
                : null;
            lastErrors = [guard, browser.errors].filter(Boolean).join("\n\n") || null;
            score = lastErrors ? 2 : 0;
            if (!lastErrors && !checksReviewed) {
                checksReviewed = true;
                await setStatus("Reviewing the checks");
                lastErrors = await reviewChecks(browser.weakChecks, browser.initialText);
                score = lastErrors ? 1 : 0;
            }
        }
        latestScore = score;
        // Ties go to the later version, which has more of the agent's work
        if (!best || score <= best.score) {
            best = { score, files: { ...network.state.data.files }, errors: lastErrors };
        }
        changedSinceCheck = false;
        return lastErrors;
    };

    // The code agent's tools and hooks, shared by the agent that fixes errors,
    // which can use another model (GEMINI_FIX_MODEL)
    const agentOptions: Omit<Parameters<typeof createAgent<AgentState>>[0], "name" | "model"> = {
      description: "An expert coding agent",
      system: PROMPT,
      tools: [
        createTool({
            name: "terminal",
            description: "Use the terminal to run commands",
            parameters: z.object({
                command: z.string(),
            }),
            handler: async ({ command }, { step }) => {
                return await step?.run("terminal", async () => {
                    const buffers = { stdout: "", stderr: "" };

                    try {
                        const sandbox = await getSandbox(sandboxId);
                        const result = await sandbox.commands.run(command, {
                            onStdout: (data: string) => {
                                buffers.stdout += data;
                            },
                            onStderr: (data: string) => {
                                buffers.stderr += data;
                            }
                        });
                        return result.stdout;
                    } catch (error) {
                        console.error(
                            `Command failed: ${error}\nstdout: ${buffers.stdout}\nstderror: ${buffers.stderr}`,
                        );
                        // for AI agents, we return the error message so that the agent can handle it gracefully
                        return `Command failed: ${error}\nstdout: ${buffers.stdout}\nstderror: ${buffers.stderr}`;
                    }
                });
            }
        }),
        createTool({
            name: "createOrUpdateFiles",
            description: "Create new files, or rewrite files you created in this task. To change files of the existing app, use editFile",
            parameters: z.object({
                files: z.array(
                    z.object({
                        path: z.string(),
                        content: z.string(),
                    }),
                ),
            }),
            handler: async (
                { files },
                { step, network }: Tool.Options<AgentState>
            ) => {
                // In a follow-up, the previous version's files can only be changed
                // with editFile: rewriting whole files is how "add a heading" turned
                // into a redesign, even with the prompt asking for small changes
                const existing = files.filter((file) => normalizePath(file.path) in previousFiles);
                const allowed = files.filter((file) => !(normalizePath(file.path) in previousFiles));

                if (allowed.length > 0) {
                    const newFiles = await step?.run("createOrUpdateFiles", async () => {
                        try {
                            const updatedFiles = network.state.data.files || {};
                            const sandbox = await getSandbox(sandboxId);
                            for (const file of allowed) {
                                await sandbox.files.write(file.path, file.content);
                                updatedFiles[file.path] = file.content;
                            }
                            return updatedFiles;
                        } catch (error) {
                            console.error(`Error creating or updating files: ${error}`);
                            return `Error: ${error}`;
                        }
                    });
                    if (typeof newFiles === "object") {
                        network.state.data.files = newFiles;
                    } else if (newFiles) {
                        return newFiles;
                    }
                }

                if (existing.length > 0) {
                    const written = allowed.length > 0 ? ` Written: ${allowed.map((file) => file.path).join(", ")}.` : "";
                    return `Not written: ${existing.map((file) => file.path).join(", ")} belong to the existing app. ` +
                        `Change them with editFile, replacing only the parts the request needs.${written}`;
                }
            }
        }),
        createTool({
            name: "editFile",
            description: "Change an existing file by replacing exact snippets of it. Each edit replaces oldText, which must appear exactly once in the file, with newText. Use this to change existing files: it keeps the rest of the file as it is",
            parameters: z.object({
                path: z.string(),
                edits: z.array(
                    z.object({
                        oldText: z.string(),
                        newText: z.string(),
                    }),
                ),
            }),
            handler: async (
                { path, edits },
                { step, network }: Tool.Options<AgentState>
            ) => {
                const outcome = await step?.run("editFile", async () => {
                    const sandbox = await getSandbox(sandboxId);
                    const original = await sandbox.files.read(path).catch(() => null);
                    if (original === null) {
                        return { error: `${path} doesn't exist; create it with createOrUpdateFiles.` };
                    }
                    const edited = applyEdits(original, edits);
                    if ("error" in edited) {
                        return { error: `${edited.error}, so no edits were made to ${path}. Use a snippet copied exactly from the current file (with real line breaks), that appears once.` };
                    }

                    // Check the edit doesn't break the file before writing it, so a
                    // broken edit is caught here instead of by the app check later
                    let content = edited.content;
                    let problem = await checkFileSyntax(sandbox, path, content);
                    if (problem) {
                        // Models sometimes send a replacement JSON-escaped a second time
                        const unescaped = applyEdits(original, edits, { unescape: true });
                        if (!("error" in unescaped) && unescaped.content !== content &&
                            !(await checkFileSyntax(sandbox, path, unescaped.content))) {
                            content = unescaped.content;
                            problem = "";
                        }
                    }
                    if (problem && !(await checkFileSyntax(sandbox, path, original))) {
                        return { error: `the edit would break ${path}, so it wasn't made:\n${problem}` };
                    }
                    await sandbox.files.write(path, content);
                    // A file that was already broken can be fixed step by step
                    return problem ? { content, warning: problem } : { content };
                });
                if (!outcome) return;
                if ("error" in outcome) return `Error: ${outcome.error}`;
                network.state.data.files = { ...network.state.data.files, [normalizePath(path)]: outcome.content };
                return "warning" in outcome && outcome.warning
                    ? `Edited ${path}, which still has syntax errors:\n${outcome.warning}`
                    : `Edited ${path}`;
            }
        }),
        createTool({
            name: "readFiles",
            description: "Read files from the sandbox",
            parameters: z.object({
                files: z.array(z.string()),
            }),
            handler: async ({ files }, { step }) => {
                return await step?.run("readFiles", async () => {
                    try {
                        const sandbox = await getSandbox(sandboxId);
                        // Read each file and store its content
                        const contents = [];
                        for (const file of files) {
                            const content = await sandbox.files.read(file);
                            contents.push({ path: file, content });
                        }
                        return contents;
                    } catch (error) {
                        console.error(`Error reading files: ${error}`);
                        return `Error: ${error}`;
                    }
                });
            }
        }),
      ],
      lifecycle: {
        onResponse: async ({ result, network }) => {
          if (!network) return result;
          const text = lastAssistantTextMessageContent(result);
          const callsTools = result.output.some((message) => message.type === "tool_call");
          // Done: a <task_summary>, or while fixing, a reply that calls no tool
          // (the agent was told the fix needs no new summary)
          const finished = Boolean(text?.includes("<task_summary>")) || (pendingSummary !== null && !callsTools);

          if (finished) {
            // Keep the first summary: it describes the whole task, later ones
            // tend to describe only the fix
            const summary = pendingSummary ?? text ?? "";
            // Models sometimes finish with code that doesn't compile. Check the
            // app before accepting the summary, and hand the errors back if not.
            const hasFiles = Object.keys(network.state.data.files || {}).length > 0;
            const appErrors = hasFiles ? await checkApp(network) : null;
            if (appErrors && fixAttempts < MAX_FIX_ATTEMPTS) {
              fixAttempts++;
              pendingSummary = summary;
              await setStatus(`Fixing what the check found (${fixAttempts} of ${MAX_FIX_ATTEMPTS})`);
              result.output.push({
                type: "text",
                role: "user",
                content: `The app has errors, so the task is not done yet. Fix their causes with the smallest changes that work, using editFile, without rewriting unrelated code (the files named and the files they import are included below; read others if you need them). The app is checked again as soon as you've written the fix, and if it passes the task is done, with no need for a new <task_summary>:\n\n${appErrors}`,
              });
            } else {
              network.state.data.summary = summary;
              network.state.data.appErrors = appErrors ?? undefined;
              pendingSummary = null;
            }
          } else if (!callsTools) {
            // A reply that neither uses a tool nor finishes: without a user turn
            // after it, the next request ends with the model's turn, which
            // Gemini rejects (HTTP 400)
            result.output.push({
              type: "text",
              role: "user",
              content: "Continue with the task. When it's completely done, reply with the <task_summary>.",
            });
          }
          return result;
        },
        // After the agent writes a fix, check again right away: if the app
        // passes, the task is done with the summary it already wrote, which
        // saves a model request per fix round
        onFinish: async ({ result, network }) => {
          const writes = result.toolCalls.filter((call) =>
            call.tool.name === "editFile" || call.tool.name === "createOrUpdateFiles",
          );
          // Terminal commands can change the app too (e.g. installing a package)
          if (writes.length > 0 || result.toolCalls.some((call) => call.tool.name === "terminal")) {
            changedSinceCheck = true;
          }
          if (pendingSummary && network && writes.length > 0) {
            const appErrors = await checkApp(network);
            if (appErrors && fixAttempts < MAX_FIX_ATTEMPTS) {
              fixAttempts++;
              await setStatus(`Fixing what the check found (${fixAttempts} of ${MAX_FIX_ATTEMPTS})`);
              // Tell the agent in the result of its own edit: otherwise it spends
              // a request replying before it hears the fix didn't work
              const call = writes[writes.length - 1];
              const before = typeof call.content === "string" ? call.content : JSON.stringify(call.content ?? "");
              call.content = `${before}\n\nThe app was checked after this change and still has problems. Fix them the same way; the task is done once the check passes:\n\n${appErrors}`;
            } else {
              network.state.data.summary = pendingSummary;
              network.state.data.appErrors = appErrors ?? undefined;
              pendingSummary = null;
            }
          }
          return result;
        },
      },
    };

    const buildNetwork = (on: Provider) => {
        const codeAgent = createAgent<AgentState>({
            ...agentOptions,
            name: "code-agent",
            model: createModel(on, "code"),
        });
        const fixAgent = modelName(on, "fix") === modelName(on, "code") ? codeAgent : createAgent<AgentState>({
            ...agentOptions,
            name: "fix-agent",
            model: createModel(on, "fix"),
        });
        return createNetwork<AgentState>({
            name: "code-agent-network",
            agents: fixAgent === codeAgent ? [codeAgent] : [codeAgent, fixAgent],
            // Room for the fix attempts on top of a normal run (~10-15 iterations)
            maxIter: 30,
            defaultState: state,
            router: async ({ network }) => {
                const summary = network.state.data.summary;
                if (summary) {
                    return;
                }
                // Fixing what the check found
                return pendingSummary !== null ? fixAgent : codeAgent;
            },
        });
    };

    // Runs the work, and if the provider says "out of quota", switches to the
    // fallback (Groq) and carries on from where it stopped instead of failing.
    // The switch is remembered, so the next runs start on the fallback.
    const withFallback = async <T>(work: () => Promise<T>, role: ModelRole): Promise<T> => {
        try {
            return await work();
        } catch (error) {
            if (providerFor(role) !== "gemini" || !fallbackProvider || !isQuotaError(error)) {
                throw error;
            }
            // Remember it, so the next runs don't spend retries on Gemini first
            const until = await step.run("start-provider-cooldown", () =>
                startCooldown("gemini", error instanceof Error ? error.message : String(error)),
            );
            geminiExhausted = true;
            if (!roleUsesFallback(role)) {
                console.warn(`Gemini is out of quota until ${until}, and ${fallbackProvider} can't take "${role}" work (see GROQ_ROLES)`);
                throw error;
            }
            console.warn(`Gemini is out of quota until ${until}; using ${fallbackProvider} for "${role}"`);
            provider = providerFor(role);
            await setStatus("Switching to the backup model");
            return await work();
        }
    };

    await setStatus("Writing the code");
    const result = await withFallback(async () => {
        provider = providerFor("code");
        return await buildNetwork(provider).run(event.data.value, { state });
    }, "code");
    // Ran out of iterations while fixing: the app was built, it still has errors
    if (!result.state.data.summary && pendingSummary) {
        result.state.data.summary = pendingSummary;
        result.state.data.appErrors = lastErrors ?? undefined;
    }

    // Later changes made the app worse (e.g. a fix broke a page that rendered):
    // go back to the best version the checks saw rather than leave it broken
    const bestVersion = best as { score: number; files: { [path: string]: string }; errors: string | null } | null;
    const rolledBack = Boolean(result.state.data.appErrors && bestVersion && bestVersion.score < latestScore);
    if (rolledBack && bestVersion) {
        const bestFiles = bestVersion.files;
        const currentFiles = Object.keys(result.state.data.files);
        await step.run("restore-best-version", async () => {
            const sandbox = await getSandbox(sandboxId);
            for (const [path, content] of Object.entries(bestFiles)) {
                if (path !== "package.json") await sandbox.files.write(path, content);
            }
            for (const path of currentFiles) {
                if (!(path in bestFiles)) await sandbox.files.remove(path).catch(() => {});
            }
        });
        result.state.data.files = { ...bestFiles };
        result.state.data.appErrors = bestVersion.errors ?? undefined;
    }
    // Only the checks review has findings: the app itself works, so the user
    // isn't told it's broken (or refunded)
    if ((rolledBack && bestVersion ? bestVersion.score : latestScore) === 1) {
        result.state.data.appErrors = undefined;
    }

    await setStatus("Writing up what was built");

    const makeFragmentTitleGenerator = () => createAgent({
        name: "fragment-title-generator",
        description: "A fragment title generator",
        system: FRAGMENT_TITLE_PROMPT,
        model: createModel(providerFor("summary"), "summary", 0.1),
    });

    const makeResponseGenerator = () => createAgent({
        name: "response-generator",
        description: "A response generator",
        system: RESPONSE_PROMPT,
        model: createModel(providerFor("summary"), "summary", 0.1),
    });

    const isError =
        !result.state.data.summary ||
        Object.keys(result.state.data.files || {}).length === 0;

    // Only summarize successful runs: an empty summary is rejected by Gemini
    // and would turn a normal error message into a failed, retried function.
    const fragmentTitleOutput = isError
        ? []
        : (await withFallback(() => makeFragmentTitleGenerator().run(result.state.data.summary), "summary")).output;
    const responseOutput = isError
        ? []
        : (await withFallback(() => makeResponseGenerator().run(result.state.data.summary), "summary")).output;

    const sandboxUrl = await step.run("get-sandbox-url", async () => {
        const sandbox = await getSandbox(sandboxId);
        const host = sandbox.getHost(3000);
        return `https://${host}`;
    });

    // The agent ran out of fix attempts: keep the result (the code and most of
    // the app may be fine), but say so and don't charge for it.
    const { appErrors } = result.state.data;
    if (!isError && appErrors) {
        await step.run("refund-broken-result", async () => {
            const project = await prisma.project.findUnique({
                where: { id: event.data.projectId },
            });
            if (project) await refundCredits(project.userId);
        });
    }

    // Keep package.json with the files when the agent installed packages, so the
    // next run can install them again (see restore-files)
    const packageJson = await step.run("read-package-json", async () => {
        const sandbox = await getSandbox(sandboxId);
        return await sandbox.files.read("package.json");
    });
    const files = { ...result.state.data.files };
    delete files["package.json"];
    if (packagesChanged(templatePackageJson, packageJson)) {
        files["package.json"] = packageJson;
    }

    await setStatus(null);

    //? saving to the database
    await step.run("save-result", async () => {
        if (isError) {
            return await prisma.message.create({
                data: {
                    projectId: event.data.projectId,
                    content: "Something went wrong. Please try again later !",
                    role: "ASSISTANT",
                    type: "ERROR",
                },
            });
        }
        return await prisma.message.create({
            data: {
                projectId: event.data.projectId,
                content: appErrors
                    ? `${parseAgentOutput(responseOutput, "Here you go")}\n\nHeads up: ${rolledBack ? "my last changes made the app worse, so I undid them, but the version you see" : "the preview"} still has errors I couldn't fix, so your credit was refunded. Send a message asking me to fix them:\n\n${appErrors.slice(0, 1500)}`
                    : rolledBack
                        ? `${parseAgentOutput(responseOutput, "Here you go")}\n\nNote: some of my last changes broke the app, so I undid them and kept the last version that worked.`
                        : parseAgentOutput(responseOutput, "Here you go"),
                role: "ASSISTANT",
                type: "RESULT",
                 fragment: {
                    create: {
                        sandboxUrl: sandboxUrl,
                        title: parseAgentOutput(fragmentTitleOutput, "Fragment"),
                        files,
                    },
                },
            },
        });
    });

    return {
        url: sandboxUrl,
        title: "Fragment",
        files,
        summary: result.state.data.summary,
    };

  },
);
