<div align="center">

<img src="./public/logo.png" alt="Craafter Logo" width="100" height="100" />

# Craafter

**AI Web App Builder with Live Cloud Sandboxes**

Describe an app in plain English, watch an AI agent build it in a cloud sandbox, then preview it, read the code, and keep iterating by chat.

[![Next.js](https://img.shields.io/badge/Next.js-15.5-black?style=flat-square&logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-blue?style=flat-square&logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-38bdf8?style=flat-square&logo=tailwindcss)](https://tailwindcss.com/)
[![Inngest Agent Kit](https://img.shields.io/badge/Inngest-Agent_Kit-000000?style=flat-square&logo=inngest)](https://agent-kit.inngest.com/)
[![Google Gemini](https://img.shields.io/badge/Google_Gemini-3.5_Flash-4285f4?style=flat-square&logo=google-gemini)](https://ai.google.dev/)
[![E2B Sandboxes](https://img.shields.io/badge/E2B-Code_Interpreter-ff5a5f?style=flat-square)](https://e2b.dev/)
[![tRPC](https://img.shields.io/badge/tRPC-v11-2563eb?style=flat-square&logo=trpc)](https://trpc.io/)
[![Prisma](https://img.shields.io/badge/Prisma-v6-2d3748?style=flat-square&logo=prisma)](https://www.prisma.io/)
[![Clerk](https://img.shields.io/badge/Clerk-Auth_%26_Billing-6c47ff?style=flat-square&logo=clerk)](https://clerk.com/)

[Features](#-key-features) • [Architecture](#-system-architecture) • [Tech Stack](#-technology-stack) • [Getting Started](#-getting-started) • [Environment Variables](#-environment-variables) • [Project Structure](#-project-structure) • [Known Limitations](#-known-limitations)

</div>

---

## 🌟 Overview

**Craafter** is an AI app builder inspired by v0 and Bolt. A user describes a web app, and an AI coding agent builds it as a Next.js app inside an isolated **E2B** cloud sandbox (Next.js 15, Tailwind CSS v4 and all shadcn/ui components preinstalled).

The user can try the running app in a live preview, browse and copy the generated code, and send follow-up prompts to change it.

Generated apps are frontend apps: the agent is instructed to use static/local data only (no external APIs or databases).

---

## ✨ Key Features

- **🤖 AI Agent Workflow** (`@inngest/agent-kit` + Google Gemini)
  - **Code agent** (`gemini-3.5-flash`): writes and reads files and runs terminal commands (e.g. `npm install <pkg>`) in the sandbox, for up to 30 iterations, and finishes with a `<task_summary>`.
  - **App check**: before a result is accepted, every page is loaded in the sandbox and parsed for syntax errors, then tested in headless Chromium: first the agent's own **acceptance checks** (`craafter.checks.json`: steps like "type 40 into Bill amount, click Calculate, expect Tip: $6.00", which catch results that are wrong without crashing), then a smoke test that clicks every control, tries menus and selects, drags items, types edge-case values, does random action sequences, follows the app's links, and flags `NaN`/`undefined`-style output and failed requests. Mechanical mistakes (missing imports, a missing `"use client"`, uninstalled packages) are fixed automatically without the model. Once everything passes, the cheaper summary model reviews the checks against the user's requests once (features without a check, checks expecting a wrong result or proving nothing), and a failing check that gets weakened instead of fixed is flagged. Remaining problems go back to the agent (or to `GEMINI_FIX_MODEL`) with the files involved (up to `CODE_AGENT_FIX_ATTEMPTS` rounds, default 3), and the app is re-checked as soon as a fix is written. If a fix makes things worse, the run falls back to the best version the checks saw; if problems remain, the reply says so and the credit is refunded.
  - Follow-up messages continue from the latest version: its files and packages are restored into the new sandbox, and the agent changes existing files only through targeted `editFile` replacements (whole-file rewrites of the existing app are refused), so a small request stays a small change.
  - **Title generator** and **response generator** (`gemini-3.5-flash-lite`): turn the summary into a short fragment title and a friendly reply.

- **⚡ Live Cloud Sandboxes**
  - Each generation runs in an E2B sandbox with a Next.js dev server and hot reload.
  - Preview iframe with refresh, copy-URL and open-in-new-tab controls.
  - Errors thrown in the preview (clicks, effects, async code) show up above it with a **Fix it** button.

- **💻 Code Explorer**
  - Resizable split view with a file tree and path breadcrumbs.
  - Prism.js syntax highlighting (JS/JSX/TS/TSX) with one-click copy.

- **🔄 Fragments**
  - Every successful turn saves a "Fragment": the generated files plus the sandbox URL.
  - Click any fragment in the chat to view its code (see [Known Limitations](#-known-limitations) for previews).

- **💳 Credits & Plans**
  - Credits tracked with `rate-limiter-flexible` in PostgreSQL: **Free = 5**, **Pro = 100** credits per 30 days, 1 credit per generation.
  - Pro plan detected with Clerk Billing (`has({ plan: "pro" })`); `/pricing` shows Clerk's `<PricingTable />`.
  - If a generation fails, the credit is refunded and an error message is shown in the chat.

- **🛡️ End-to-End Type Safety** with tRPC v11, TanStack Query v5, Zod and SuperJSON.

- **🎨 Light/Dark Themes** via `next-themes`, with Sonner toasts.

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    User([User / Browser]) <-->|Chat prompt & live UI| NextApp[Next.js 15 App Router]
    NextApp <-->|Queries & mutations| TRPCRouter[tRPC v11 API]
    TRPCRouter -->|Consume credit| UsageTracker[Usage limiter / Prisma]
    UsageTracker --> DB[(PostgreSQL)]
    TRPCRouter -->|Send 'code-agent/run' event| InngestEngine[Inngest Dev Server / Cloud]

    subgraph Background Workflow [Inngest function: code-agent]
        InngestEngine --> Step1[Step: Create E2B sandbox]
        Step1 --> Step2[Step: Load last 5 messages]
        Step2 --> CodeAgent[Code agent - gemini-3.5-flash]

        subgraph Sandbox Execution [E2B sandbox]
            CodeAgent -->|terminal| BashExec[Run commands]
            CodeAgent -->|createOrUpdateFiles| FSWrite[Write files]
            CodeAgent -->|readFiles| FSRead[Read files]
            DevServer[Next.js dev server :3000] <-->|Hot reload| FSWrite
        end

        CodeAgent -->|task_summary| TitleAgent[Title generator]
        CodeAgent -->|task_summary| RespAgent[Response generator]
        TitleAgent & RespAgent --> StepSave[Step: Save message & fragment]
        InngestEngine -.->|All retries failed| OnFailure[onFailure: save error message & refund credit]
    end

    StepSave --> DB
    OnFailure --> DB
    NextApp -.->|Poll messages every 2s| TRPCRouter
    NextApp <-->|Preview iframe| DevServer
```

---

## 🛠️ Technology Stack

| Category | Technology | Description |
|---|---|---|
| **Framework** | [Next.js 15](https://nextjs.org/) | App Router, React 19, Turbopack |
| **Language** | [TypeScript](https://www.typescriptlang.org/) | Strict typing across client, server and agents |
| **Styling** | [Tailwind CSS v4](https://tailwindcss.com/) | Utility-first styling |
| **Components** | [shadcn/ui](https://ui.shadcn.com/) / [Radix UI](https://www.radix-ui.com/) | Accessible primitives |
| **Agent Framework** | [@inngest/agent-kit](https://agent-kit.inngest.com/) | Agents, tools, networks (patched, see below) |
| **LLM** | [Google Gemini](https://ai.google.dev/) | `gemini-3.5-flash` (code), `gemini-3.5-flash-lite` (title & reply) |
| **Sandboxing** | [@e2b/code-interpreter](https://e2b.dev/) | Cloud sandboxes with public ports |
| **Background Jobs** | [Inngest](https://www.inngest.com/) | Durable, retried step functions |
| **API Layer** | [tRPC v11](https://trpc.io/) | Type-safe RPC |
| **Client State** | [TanStack Query v5](https://tanstack.com/query) | Caching, polling, mutations |
| **Database & ORM** | [Prisma v6](https://www.prisma.io/) + PostgreSQL | Projects, messages, fragments, usage |
| **Auth & Billing** | [Clerk](https://clerk.com/) | Sign-in, route protection, subscription plans |
| **Rate Limiting** | [rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible) | PostgreSQL-backed credits |
| **Code Viewer** | [Prism.js](https://prismjs.com/) | Syntax highlighting |

---

## 📁 Project Structure

```text
craafter/
├── patches/
│   └── @inngest+agent-kit+0.8.4.patch   # Gemini 3 + inngest 3.5x compatibility fixes (applied on npm install)
├── prisma/
│   ├── schema.prisma            # Project, Message, Fragment, Usage
│   └── migrations/              # SQL migrations
├── public/                      # Logo and static assets
├── sandbox-templates/
│   └── nextjs/
│       ├── app-template/        # The Next.js 15.3.3 + shadcn app the agent builds on (with its lockfile)
│       ├── compile_page.sh      # Starts the sandbox dev server and warms up the / page
│       ├── e2b.Dockerfile       # Sandbox image (Node 21 + app-template + headless Chromium)
│       └── e2b.toml             # Config of the previous template (craafter-nextjs-test-2)
├── src/
│   ├── app/
│   │   ├── (home)/              # Landing page, /pricing, /sign-in, /sign-up
│   │   ├── api/                 # /api/inngest and /api/trpc route handlers
│   │   ├── projects/[projectId] # Project builder page (server prefetch + ProjectView)
│   │   ├── error.tsx            # Global error page
│   │   ├── globals.css          # Tailwind theme tokens
│   │   └── layout.tsx           # Providers (Clerk, tRPC, theme, toaster)
│   ├── components/
│   │   ├── code-view/           # Prism code viewer and theme
│   │   ├── ui/                  # shadcn/ui primitives
│   │   ├── file-explorer.tsx    # File tree + breadcrumbs + code view
│   │   ├── tree-view.tsx        # Recursive file tree
│   │   ├── hint.tsx             # Tooltip wrapper
│   │   └── user-control.tsx     # Clerk user button
│   ├── generated/prisma/        # Generated Prisma client (git-ignored)
│   ├── hooks/                   # Theme, mobile and scroll hooks
│   ├── inngest/
│   │   ├── client.ts            # Inngest client
│   │   ├── functions.ts         # code-agent function (agents, tools, onFailure)
│   │   ├── types.ts             # Sandbox timeout
│   │   └── utils.ts             # Sandbox and agent output helpers
│   ├── lib/                     # Prisma client, credits (consume / refund / status), utils
│   ├── modules/
│   │   ├── home/                # Navbar, project form, projects list, prompt templates
│   │   ├── messages/server/     # messages tRPC router (list, create)
│   │   ├── projects/            # projects tRPC router + chat UI, preview, header, usage banner
│   │   └── usage/server/        # usage tRPC router (credit status)
│   ├── prompt.ts                # System prompts for the three agents
│   ├── trpc/                    # tRPC init, client, server helpers, app router
│   ├── types.ts                 # Shared types (file tree)
│   └── middleware.ts            # Clerk route protection
├── .env.example                 # Environment variable template
├── components.json              # shadcn config
├── next.config.ts
├── package.json
└── tsconfig.json
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 20 or newer, and npm
- **PostgreSQL**, local or hosted (e.g. [Neon](https://neon.tech))
- **Accounts & API keys**:
  - [Google AI Studio](https://aistudio.google.com/apikey): `GEMINI_API_KEY`
  - [E2B](https://e2b.dev/): `E2B_API_KEY`
  - [Clerk](https://clerk.com/): publishable & secret keys, with Billing plans `free_user` and `pro`
  - [Inngest](https://www.inngest.com/): only needed for production; locally the CLI dev server is used

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/<your-username>/craafter.git
   cd craafter
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```
   > `postinstall` runs `patch-package` (applies `patches/`) and `prisma generate`.

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   Fill in the keys. Use `.env` rather than `.env.local`, because the Prisma CLI only reads `.env`. See [Environment Variables](#-environment-variables).

4. **Set up the database**
   ```bash
   npx prisma migrate deploy
   ```

5. **Start the app and the Inngest dev server** (two terminals)
   ```bash
   npm run dev          # Next.js on http://localhost:3000
   npm run dev:inngest  # Inngest dev server on http://localhost:8288
   ```
   > If port 3000 is taken, Next.js picks another port. Then set `NEXT_PUBLIC_APP_URL` to that URL and point Inngest at it:
   > `npx inngest-cli@latest dev -u http://localhost:<port>/api/inngest`

6. **Open** [http://localhost:3000](http://localhost:3000), sign in and submit a prompt. You can follow each run step by step in the Inngest dashboard at [http://localhost:8288](http://localhost:8288).

### (Optional) Custom E2B Sandbox Template

The app uses the E2B template `craafter-nextjs-v3` (2 vCPU, 2 GB RAM: the dev server and the headless browser of the app check don't fit in 1 GB). To build your own:

```bash
npm install -g @e2b/cli
e2b auth login
cd sandbox-templates/nextjs
e2b template create your-template-name --dockerfile e2b.Dockerfile \
  --cmd "/compile_page.sh" \
  --ready-cmd "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 | grep -q 200" \
  --memory-mb 2048 --cpu-count 2
```

Then update the template name in `src/inngest/functions.ts`:

```typescript
const sandbox = await Sandbox.create("your-template-name");
```

---

## 🔐 Environment Variables

See `.env.example` for a ready-to-copy template.

| Variable | Description | Required | Example |
|---|---|:---:|---|
| `NEXT_PUBLIC_APP_URL` | App base URL (used by tRPC during server rendering) | Yes | `http://localhost:3000` |
| `DATABASE_URL` | PostgreSQL connection string | Yes | `postgresql://user:pwd@host:5432/craafter` |
| `GEMINI_API_KEY` | Google Gemini API key | Yes | from AI Studio |
| `GEMINI_CODE_MODEL` | Override the code agent model | No | `gemini-3.5-flash` (default) |
| `GEMINI_SUMMARY_MODEL` | Override the title & reply model | No | `gemini-3.5-flash-lite` (default) |
| `GEMINI_FIX_MODEL` | Model for fixing errors the app check finds (a stronger one fixes more, only these requests use it) | No | same as `GEMINI_CODE_MODEL` |
| `GEMINI_REVIEW_MODEL` | Model for reviewing the acceptance checks | No | same as `GEMINI_SUMMARY_MODEL` |
| `GROQ_API_KEY` | Fallback provider used when Gemini is out of quota (free key at console.groq.com) | No | — (fallback off) |
| `GROQ_CODE_MODEL` / `GROQ_SUMMARY_MODEL` | Groq models per role | No | `openai/gpt-oss-20b` |
| `GROQ_ROLES` | What the fallback may take over. Groq's free tier caps requests at 8,000 tokens/minute, which one code-agent request exceeds, so by default only the title, reply and checks review fall back. On a paid tier: `code,fix,summary,review` | No | `summary,review` |
| `PROVIDER_COOLDOWN_MINUTES` | How long runs keep using the fallback after Gemini ran out | No | `120` |
| `CODE_AGENT_FIX_ATTEMPTS` | Rounds the agent gets to fix errors the app check finds; each costs a few model requests, `0` only reports them | No | `3` (default) |
| `E2B_API_KEY` | E2B API key | Yes | `e2b_...` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key | Yes | `pk_test_...` |
| `CLERK_SECRET_KEY` | Clerk secret key | Yes | `sk_test_...` |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Sign-in page route | Yes | `/sign-in` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Sign-up page route | Yes | `/sign-up` |
| `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` | Where to go after sign-in | Yes | `/` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` | Where to go after sign-up | Yes | `/` |
| `INNGEST_DEV` | `1` locally, so events go to the local dev server | Local | `1` |
| `INNGEST_EVENT_KEY` | Inngest event key | Production | from Inngest Cloud |
| `INNGEST_SIGNING_KEY` | Inngest signing key | Production | `signkey-prod-...` |

> **Keep `INNGEST_DEV=1` locally.** Without it, if no local dev server is found, the SDK sends events to **Inngest Cloud**. They then run on your deployed app, with its environment variables, instead of your machine.

---

## 📜 Available Scripts

| Script | Command | Description |
|---|---|---|
| `dev` | `next dev --turbopack` | Next.js dev server |
| `dev:inngest` | `npx inngest-cli@latest dev -u http://localhost:3000/api/inngest` | Local Inngest dev server |
| `build` | `next build` | Production build |
| `start` | `next start` | Run the production build |
| `lint` | `next lint` | ESLint |
| `postinstall` | `patch-package && prisma generate` | Apply dependency patches and generate the Prisma client |

---

## 💡 How It Works

1. **Prompt & credits**
   - The user submits a prompt, or picks a starter template (Netflix, admin dashboard, kanban, …).
   - `projects.create` (new project) or `messages.create` (follow-up) consumes 1 credit, saves the user message and sends a `code-agent/run` event.
   - If the event can't be sent, the credit is refunded and an error message is saved.

2. **Agent run** (`src/inngest/functions.ts`)
   - Creates an E2B sandbox with a 15-minute timeout.
   - Loads the previous 5 messages (excluding the current prompt, which is passed separately) as context.
   - The code agent loops (max 20 iterations) using `terminal`, `createOrUpdateFiles` and `readFiles`, until it outputs `<task_summary>`.
   - The title and response agents turn the summary into a fragment title and a reply.
   - Saves an assistant message with a Fragment (files + sandbox URL). If there is no summary or no files, it saves an error message instead.
   - If the function fails after all retries, `onFailure` saves an error message and refunds the credit.

3. **UI updates**
   - The project page polls messages every 2 seconds, shows a loading state while the latest message is from the user, and opens the newest fragment in the Demo/Code panel.

### Why `patches/@inngest+agent-kit+0.8.4.patch`?

`@inngest/agent-kit@0.8.4` (and the latest 0.13.x at the time of writing) doesn't work with Gemini 3 models or newer inngest versions. The patch fixes three things:

1. **Thought signatures.** Gemini 3 rejects replayed tool calls without a `thoughtSignature` (HTTP 400), and agent-kit dropped them. The patch keeps the real signature from each response and sends it back with the call. Google's placeholder `skip_thought_signature_validator` is only used if a signature is missing. With only the placeholder, the model degrades badly: after a few tool calls it keeps returning empty `MALFORMED_FUNCTION_CALL` responses and never finishes.
2. **System prompt.** agent-kit sent the system prompt as a normal `user` message. `gemini-3.5-flash` answers that with a misleading `503 "This model is currently experiencing high demand"`. The patch sends it as `systemInstruction`.
3. **inngest ≥ 3.5x async context.** inngest moved the function context from `asyncCtx.ctx` to `asyncCtx.execution.ctx`. Without the fix, `network.run()` crashes with `Cannot read properties of undefined (reading 'step')`.

Separately, the system prompt tells the agent to write at most 3 files per `createOrUpdateFiles` call, because very large calls are more likely to fail.

The patch is applied automatically on `npm install`. If you upgrade `@inngest/agent-kit`, check whether these are fixed upstream, then regenerate or remove the patch.

---

## ⚠️ Known Limitations

- **Previews expire.** Sandboxes shut down 30 minutes after the last activity (`SANDBOX_TIMEOUT`; the E2B plan allows up to 1 hour). The code of older fragments is still viewable, but their Demo iframe stops loading.
- **Gemini free tier.** Free-tier keys have low per-model daily limits: `gemini-3.6-flash` and `gemini-3.5-flash` allow only 20 requests/day each, and one generation uses roughly 8–20, plus about 1–2 per fix round when the app check finds problems (see `CODE_AGENT_FIX_ATTEMPTS`). On a free key, set `GEMINI_CODE_MODEL=gemini-3.5-flash-lite` for more generations per day, or use a paid key. Set `GEMINI_CODE_MODEL` / `GEMINI_SUMMARY_MODEL` to use other models. Pro models (e.g. `gemini-3.1-pro-preview`) return HTTP 429 on free-tier keys, and `gemini-2.5-*` models are closed to new API keys. The free tier also has low per-minute limits, so a long agent run can hit rate limits; Inngest retries those steps. Set `GROQ_API_KEY` to keep the small calls (title, reply, checks review) working when Gemini's daily quota runs out; the switch is remembered for `PROVIDER_COOLDOWN_MINUTES` so later runs don't spend retries on Gemini first.
- **Frontend only.** Generated apps use local/static data. There is no backend or database generation.
- **The app check can't prove an app correct.** Acceptance checks cover what the agent wrote them for; the review catches requested features without a check and wrong expected results, but it's a model too and can miss things. The smoke test gets up to 4 minutes for up to 10 pages. So some wrong behavior can still slip through; it shows up in the preview's error bar, with a **Fix it** button. Fix rounds that need the model cost about one Gemini request each (mechanical fixes cost none), and the checks review one request to the summary model.

---

## 🤝 Contributing

Contributions, issues and feature requests are welcome.

1. Fork the project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request
