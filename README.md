<div align="center">

<img src="./public/logo.png" alt="Craafter Logo" width="100" height="100" />

# Craafter

**AI-Powered Full-Stack Web Application Builder & Cloud Sandbox Playground**

Create, preview, iterate, and inspect full-stack web applications in real time through conversational AI.

[![Next.js](https://img.shields.io/badge/Next.js-15.3.4-black?style=flat-square&logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19.0.0-blue?style=flat-square&logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-38bdf8?style=flat-square&logo=tailwindcss)](https://tailwindcss.com/)
[![Inngest Agent Kit](https://img.shields.io/badge/Inngest-Agent_Kit-000000?style=flat-square&logo=inngest)](https://agent-kit.inngest.com/)
[![Google Gemini](https://img.shields.io/badge/Google_Gemini-2.5_Pro-4285f4?style=flat-square&logo=google-gemini)](https://ai.google.dev/)
[![E2B Sandboxes](https://img.shields.io/badge/E2B-Code_Interpreter-ff5a5f?style=flat-square)](https://e2b.dev/)
[![tRPC](https://img.shields.io/badge/tRPC-v11-2563eb?style=flat-square&logo=trpc)](https://trpc.io/)
[![Prisma](https://img.shields.io/badge/Prisma-v6-2d3748?style=flat-square&logo=prisma)](https://www.prisma.io/)
[![Clerk](https://img.shields.io/badge/Clerk-Auth_%26_Billing-6c47ff?style=flat-square&logo=clerk)](https://clerk.com/)

[Features](#-key-features) • [Architecture](#-system-architecture) • [Tech Stack](#-technology-stack) • [Getting Started](#-getting-started) • [Environment Variables](#-environment-variables) • [Project Structure](#-project-structure)

</div>

---

## 🌟 Overview

**Craafter** is an autonomous full-stack AI software development studio inspired by modern generative developer platforms like v0 and Bolt. It enables users to describe any web application in natural language and watch as an AI multi-agent system constructs a complete, production-ready Next.js application inside an isolated cloud sandbox in real time.

Every generation runs inside a live virtual sandbox container powered by **E2B**, complete with a pre-configured Next.js 15 runtime, Tailwind CSS v4, and Shadcn UI. Users can test the live application through an interactive demo preview, explore and copy generated code with syntax highlighting, and continue iterating on their application with conversational follow-up prompts.

---

## ✨ Key Features

- **🤖 Autonomous Multi-Agent AI Workflow**:
  - Powered by `@inngest/agent-kit` and **Google Gemini 2.5 Pro**.
  - **Code Agent**: Automatically writes, modifies, and inspects files, runs terminal commands (`npm install <pkg>`), and executes up to 15 iterative reasoning cycles.
  - **Fragment Title Generator**: Synthesizes concise, descriptive 3-word title tags for generated code fragments.
  - **Response Generator**: Crafts user-friendly conversational responses summarizing all code modifications.

- **⚡ Live Cloud MicroVM Sandboxes**:
  - Secure, isolated cloud environments powered by **E2B Code Interpreter** (`@e2b/code-interpreter`).
  - Next.js 15 dev server running on Turbopack with instant hot reloading.
  - Interactive preview iframe with reload controls, direct sandbox URL copying, and new-tab launching.

- **💻 In-Browser Code Explorer & Syntax Viewer**:
  - Interactive split-screen layout with resizable panels (`react-resizable-panels`).
  - File tree navigator (`TreeView`) with active path breadcrumbs.
  - Syntax-highlighted code viewer using `Prism.js` and custom themes with 1-click clipboard copying.

- **🔄 Versioned Iteration Fragments**:
  - Every conversational turn captures an immutable snapshot ("Fragment") of the sandbox file tree and preview URL.
  - Seamlessly browse past project iterations and view previous app states directly from the chat timeline.

- **🛡️ End-to-End Type Safety**:
  - Full-stack type safety with **tRPC v11**, **TanStack React Query v5**, and **Zod**.
  - Rich serialization via **SuperJSON**.

- **💳 Usage Tracking & Tiered Quotas**:
  - Credit consumption system built on `rate-limiter-flexible` and PostgreSQL via Prisma.
  - Free tier (5 generation credits) and Pro tier (100 generation credits) integrated with Clerk plan checks and embedded `<PricingTable />`.

- **🎨 Modern Dark/Light Aesthetic**:
  - Styled with Tailwind CSS v4 and Radix UI primitives.
  - Adaptive light/dark theming via `next-themes` and toast feedback with `Sonner`.

---

## 🏗️ System Architecture

Craafter decouples UI interactions, long-running agent workflows, and sandboxed code execution:

```mermaid
flowchart TD
    User([User / Browser]) <-->|Chat Prompt & Live UI| NextApp[Next.js 15 App Router]
    NextApp <-->|Type-safe Queries & Mutations| TRPCRouter[tRPC v11 API]
    TRPCRouter -->|Credit Check & Decrement| UsageTracker[Usage Limiter / Prisma]
    UsageTracker --> DB[(PostgreSQL Database)]
    TRPCRouter -->|Emit 'code-agent/run' Event| InngestEngine[Inngest Server / Cloud]
    
    subgraph Background Workflow [Inngest Multi-Agent Network]
        InngestEngine --> Step1[Step: Spawn E2B Sandbox]
        Step1 --> Step2[Step: Fetch Message History]
        Step2 --> CodeAgent[Code Agent - Gemini 2.5 Pro]
        
        subgraph Sandbox Execution [E2B Cloud MicroVM]
            CodeAgent -->|Terminal Tool| BashExec[Run Terminal Commands]
            CodeAgent -->|File Write Tool| FSWrite[Write / Update Files]
            CodeAgent -->|File Read Tool| FSRead[Read Existing Files]
            DevServer[Next.js Turbopack :3000] <-->|Hot Reload| FSWrite
        end
        
        CodeAgent -->|Task Summary| TitleAgent[Fragment Title Generator]
        CodeAgent -->|Task Summary| RespAgent[Response Generator]
        TitleAgent & RespAgent --> StepSave[Step: Save Fragment & Messages]
    end
    
    StepSave --> DB
    NextApp -.->|Poll / Query Updates| TRPCRouter
    NextApp <-->|Live Demo Preview Iframe| DevServer
```

---

## 🛠️ Technology Stack

| Category | Technology | Description |
|---|---|---|
| **Framework** | [Next.js 15](https://nextjs.org/) | App Router, React 19, Server Components & Turbopack |
| **Language** | [TypeScript](https://www.typescriptlang.org/) | Strict static typing across client, server, and agents |
| **Styling** | [Tailwind CSS v4](https://tailwindcss.com/) | Next-generation utility-first styling |
| **Component Library** | [Shadcn UI](https://ui.shadcn.com/) / [Radix UI](https://www.radix-ui.com/) | Accessible unstyled primitives with customized aesthetics |
| **Agent Framework** | [@inngest/agent-kit](https://agent-kit.inngest.com/) | Multi-agent network, tool binding, state routing |
| **LLM Provider** | [Google Gemini](https://ai.google.dev/) | `gemini-2.5-pro` for deep reasoning and code generation |
| **Sandboxing** | [@e2b/code-interpreter](https://e2b.dev/) | Isolated virtual cloud environments with live ports |
| **Background Jobs** | [Inngest](https://www.inngest.com/) | Reliable serverless event orchestration & step execution |
| **API Layer** | [tRPC v11](https://trpc.io/) | End-to-end type-safe client-server RPCs |
| **Client State** | [@tanstack/react-query v5](https://tanstack.com/query) | Asynchronous query caching, mutations, and polling |
| **Database & ORM** | [Prisma v6](https://www.prisma.io/) + PostgreSQL | Relational persistence for projects, messages, fragments, usage |
| **Authentication** | [Clerk](https://clerk.com/) | User management, session protection, and subscription tiers |
| **Rate Limiting** | [rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible) | PostgreSQL-backed credit tracking |
| **Code Viewer** | [Prism.js](https://prismjs.com/) | Custom-themed in-browser syntax highlighting |

---

## 📁 Project Structure

```text
craafter/
├── prisma/
│   └── schema.prisma            # PostgreSQL schema (Project, Message, Fragment, Usage)
├── public/                      # Static branding assets and icons
├── sandbox-templates/
│   └── nextjs/
│       ├── compile_page.sh      # Sandbox pre-compilation script for warm start
│       ├── e2b.Dockerfile       # E2B microVM template image (Node 21 + Next.js + Shadcn)
│       └── e2b.toml             # E2B sandbox configuration and template definition
├── src/
│   ├── app/                     # Next.js App Router
│   │   ├── (home)/              # Landing page, pricing table, auth routes (sign-in/up)
│   │   ├── api/                 # Route handlers (Inngest webhook & tRPC endpoint)
│   │   ├── projects/[projectId] # Interactive project builder interface
│   │   ├── globals.css          # Core styles & Tailwind tokens
│   │   └── layout.tsx           # Providers (Clerk, TRPC, Theme, Toaster)
│   ├── components/              # Shared UI components
│   │   ├── code-view/           # Prism syntax highlighter and theme
│   │   ├── ui/                  # Shadcn UI primitives (accordion, button, dialog, etc.)
│   │   ├── file-explorer.tsx    # Split file explorer with breadcrumbs & tree
│   │   └── tree-view.tsx        # Recursive directory tree navigation
│   ├── hooks/                   # Custom React hooks (theme, mobile detection, scroll)
│   ├── inngest/                 # Inngest orchestration logic
│   │   ├── client.ts            # Inngest client instance
│   │   ├── functions.ts         # Multi-agent code-agent function definition
│   │   ├── types.ts             # Sandbox timeout and execution constants
│   │   └── utils.ts             # Agent parsing utilities & sandbox helpers
│   ├── lib/                     # Database client, credit consumption, helper utils
│   ├── modules/                 # Domain-driven feature modules
│   │   ├── home/                # Home form, project templates list, navbar
│   │   ├── messages/            # Chat message cards, loading states, tRPC router
│   │   ├── projects/            # Project header, preview pane (FragmentWeb), tRPC router
│   │   └── usage/               # Credit usage status procedures
│   ├── prompt.ts                # System prompts for Code Agent, Title & Response agents
│   ├── trpc/                    # tRPC client, context initialization, app router
│   └── middleware.ts            # Clerk route authentication protection
├── .env.example                 # Documented template for required environment variables
├── components.json              # Shadcn component configuration
├── next.config.ts               # Next.js configuration
├── package.json                 # Dependencies and build scripts
└── tsconfig.json                # TypeScript compiler configuration
```

---

## 🚀 Getting Started

### Prerequisites

Ensure you have the following installed and set up before running the project:

- **Node.js**: `v20.x` or higher
- **npm**, **pnpm**, or **yarn**
- **PostgreSQL**: Local instance, or a hosted service like [Neon](https://neon.tech), [Supabase](https://supabase.com), or Docker
- **Accounts & API Keys**:
  - [Google AI Studio](https://aistudio.google.com/) (for `GEMINI_API_KEY`)
  - [E2B](https://e2b.dev/) (for `E2B_API_KEY`)
  - [Clerk](https://clerk.com/) (Publishable & Secret keys)
  - [Inngest](https://www.inngest.com/) (Local CLI or Cloud account)

---

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-username/craafter.git
   cd craafter
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```
   > *Note: A `postinstall` script automatically runs `prisma generate`.*

3. **Configure environment variables**:
   Copy the example environment file and fill in your keys:
   ```bash
   cp .env.example .env.local
   ```
   *(See [Environment Variables](#-environment-variables) below for details).*

4. **Initialize the database**:
   Push the Prisma schema to your PostgreSQL database:
   ```bash
   npx prisma db push
   ```

5. **Start the Inngest Dev Server**:
   In a separate terminal window, launch the Inngest CLI to handle agent events locally:
   ```bash
   npx inngest-cli@latest dev
   ```
   The Inngest dashboard will be available at [http://localhost:8288](http://localhost:8288).

6. **Start the Next.js development server**:
   ```bash
   npm run dev
   ```

7. **Open the application**:
   Navigate to [http://localhost:3000](http://localhost:3000) in your browser.

---

### (Optional) Building a Custom E2B Sandbox Template

By default, the application connects to the pre-built E2B template `craafter-nextjs-test-2`. If you wish to build and deploy your own sandbox template with custom dependencies:

1. Install the E2B CLI:
   ```bash
   npm install -g @e2b/cli
   ```
2. Log in to your E2B account:
   ```bash
   e2b auth login
   ```
3. Navigate to the sandbox template directory and build:
   ```bash
   cd sandbox-templates/nextjs
   e2b template build
   ```
4. Update the template name in `src/inngest/functions.ts` if you choose a custom name:
   ```typescript
   const sandbox = await Sandbox.create("your-template-name");
   ```

---

## 🔐 Environment Variables

Create a `.env` (or `.env.local`) file in the root directory. You can reference `.env.example`:

| Variable | Description | Required | Example |
|---|---|:---:|---|
| `NEXT_PUBLIC_APP_URL` | Base application URL for tRPC client links | Yes | `http://localhost:3000` |
| `DATABASE_URL` | PostgreSQL connection string | Yes | `postgresql://user:pwd@localhost:5432/craafter` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk Publishable Key | Yes | `pk_test_...` |
| `CLERK_SECRET_KEY` | Clerk Secret Key | Yes | `sk_test_...` |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Clerk sign-in redirect URL | Yes | `/sign-in` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Clerk sign-up redirect URL | Yes | `/sign-up` |
| `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL` | Post sign-in destination | Yes | `/` |
| `NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL` | Post sign-up destination | Yes | `/` |
| `GEMINI_API_KEY` | Google Gemini API Key for code generation | Yes | `AIzaSy...` |
| `E2B_API_KEY` | E2B API Key for cloud sandbox containers | Yes | `e2b_...` |
| `INNGEST_EVENT_KEY` | Inngest Event Key (production webhook signing) | No (Local) | `ey...` |
| `INNGEST_SIGNING_KEY` | Inngest Signing Key (production webhook verification) | No (Local) | `signkey-prod-...` |

---

## 📜 Available Scripts

| Script | Command | Description |
|---|---|---|
| `dev` | `next dev --turbopack` | Starts the Next.js development server with Turbopack |
| `build` | `next build` | Compiles the production build |
| `start` | `next start` | Runs the compiled production application |
| `lint` | `next lint` | Executes ESLint to check for code issues |
| `postinstall` | `prisma generate` | Generates the Prisma client automatically after installs |

---

## 💡 How It Works Under the Hood

1. **Prompt Ingestion & Usage Check**:
   - The user inputs a prompt describing an application (or selects from starter templates like Netflix, Airbnb, or Spotify clones).
   - The tRPC `projects.create` procedure checks available credits via `consumeCredits()`. Free accounts get 5 credits, while Pro accounts get 100 credits per 30 days.
   - If verified, a project record and initial message are created, and an event `code-agent/run` is emitted to Inngest.

2. **Inngest Multi-Agent Execution**:
   - An isolated E2B cloud sandbox microVM is spawned with a 15-minute active timeout.
   - Message history (up to the last 5 messages) is loaded into agent state.
   - The **Code Agent** executes in a network loop (up to 15 iterations):
     - Uses `terminal` to run bash commands (e.g., `npm install <package> --yes`).
     - Uses `createOrUpdateFiles` to stream code into the sandbox file system.
     - Uses `readFiles` to inspect existing code and dependencies.
   - Once completed, the agent outputs a structured `<task_summary>`.
   - **Fragment Title Generator** & **Response Generator** agents convert the summary into a 3-word title and concise user feedback.

3. **Live Sync & Interactive Rendering**:
   - The generated code and public sandbox URL (`https://<host>:3000`) are stored as a new `Fragment` in PostgreSQL.
   - The client UI auto-updates, revealing the live Next.js demo in the preview pane alongside the file explorer and code viewer.

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome!

1. Fork the project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request
