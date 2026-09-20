import { gemini, openai } from "@inngest/agent-kit";

import prisma from "@/lib/db";

// Gemini does the work; Groq takes over when Gemini is rate limited or out of
// daily quota, which on a free key happens mid-day. Groq is used only if
// GROQ_API_KEY is set.
export type Provider = "gemini" | "groq";

// What each model is used for: writing the app, fixing what the check found,
// the title and reply, and reviewing the acceptance checks.
export type ModelRole = "code" | "fix" | "summary" | "review";

// gemini-2.5-* is closed to new API keys, and gemini-3.6-flash allows only 20
// requests/day on the free tier (~1 generation). Gemini 3 tool calls need the
// agent-kit patch in patches/ (thought signatures).
const GEMINI_MODELS: Record<ModelRole, string> = {
  code: process.env.GEMINI_CODE_MODEL || "gemini-3.5-flash",
  fix: process.env.GEMINI_FIX_MODEL || process.env.GEMINI_CODE_MODEL || "gemini-3.5-flash",
  summary: process.env.GEMINI_SUMMARY_MODEL || "gemini-3.5-flash-lite",
  review: process.env.GEMINI_REVIEW_MODEL || process.env.GEMINI_SUMMARY_MODEL || "gemini-3.5-flash-lite",
};

const GROQ_MODELS: Record<ModelRole, string> = {
  code: process.env.GROQ_CODE_MODEL || "openai/gpt-oss-20b",
  fix: process.env.GROQ_FIX_MODEL || process.env.GROQ_CODE_MODEL || "openai/gpt-oss-20b",
  summary: process.env.GROQ_SUMMARY_MODEL || "openai/gpt-oss-20b",
  review: process.env.GROQ_REVIEW_MODEL || process.env.GROQ_SUMMARY_MODEL || "openai/gpt-oss-20b",
};

// Groq speaks the OpenAI API
const GROQ_BASE_URL = "https://api.groq.com/openai/v1/";

export const fallbackProvider: Provider | null = process.env.GROQ_API_KEY ? "groq" : null;

// Which work the fallback may take over. Groq's free tier allows 8,000 tokens a
// minute, and one code-agent request (the system prompt plus the conversation)
// is bigger than that, so by default only the small calls fall back: the title,
// the reply and the checks review. On a paid Groq tier, set
// GROQ_ROLES="code,fix,summary,review" to have it take over everything.
const FALLBACK_ROLES = new Set(
  (process.env.GROQ_ROLES || "summary,review").split(",").map((role) => role.trim()).filter(Boolean),
);

export const roleUsesFallback = (role: ModelRole) => FALLBACK_ROLES.has(role);

export const createModel = (provider: Provider, role: ModelRole, temperature?: number) => {
  if (provider === "groq") {
    return openai({
      model: GROQ_MODELS[role],
      apiKey: process.env.GROQ_API_KEY,
      baseUrl: GROQ_BASE_URL,
      ...(temperature === undefined ? {} : { defaultParameters: { temperature } }),
    });
  }
  return gemini({
    model: GEMINI_MODELS[role],
    apiKey: process.env.GEMINI_API_KEY,
    ...(temperature === undefined ? {} : { defaultParameters: { generationConfig: { temperature } } }),
  });
};

export const modelName = (provider: Provider, role: ModelRole) =>
  provider === "groq" ? GROQ_MODELS[role] : GEMINI_MODELS[role];

// "You've used your quota": worth switching provider for. A wrong API key or a
// malformed request is not, and must keep failing loudly.
export const isQuotaError = (error: unknown) => {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  return /\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit|too many requests/i.test(text);
};

const COOLDOWN_MINUTES = Number.parseInt(process.env.PROVIDER_COOLDOWN_MINUTES ?? "", 10) || 120;

// Whether the primary provider recently ran out of quota
export async function isCoolingDown(provider: Provider): Promise<boolean> {
  const cooldown = await prisma.providerCooldown
    .findUnique({ where: { provider } })
    .catch(() => null);
  return Boolean(cooldown && cooldown.until > new Date());
}

export async function startCooldown(provider: Provider, reason: string) {
  const until = new Date(Date.now() + COOLDOWN_MINUTES * 60_000);
  await prisma.providerCooldown
    .upsert({
      where: { provider },
      create: { provider, until, reason: reason.slice(0, 500) },
      update: { until, reason: reason.slice(0, 500) },
    })
    .catch(() => {});
  return until;
}
