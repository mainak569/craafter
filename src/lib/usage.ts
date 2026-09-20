import { auth } from "@clerk/nextjs/server";
import { RateLimiterPrisma } from "rate-limiter-flexible";

import prisma from "@/lib/db";

const FREE_POINTS = 5;
const PRO_POINTS = 100; // Points for Pro users
const DURATION = 30 * 24 * 60 * 60; // 30 days
const GENERATION_COST = 1; // 1 point per generation

// Created once and reused: every RateLimiterPrisma instance used to start its own
// endless cleanup timer. Cleanup is off because expired rows are reset on the
// next use anyway (one row per user), and the timer's query kept the database
// awake and threw unhandled rejections when it was unreachable. Turning it off
// needs patches/rate-limiter-flexible+7.4.0.patch (the library ignored `false`).
const createTracker = (points: number) =>
  new RateLimiterPrisma({
    storeClient: prisma,
    tableName: "Usage",
    points,
    duration: DURATION,
    clearExpiredByTimeout: false,
  });

// Kept on globalThis in development, like the Prisma client, so hot reloads reuse them
const globalForUsage = globalThis as unknown as {
  usageTrackers?: { free: RateLimiterPrisma; pro: RateLimiterPrisma };
};
const usageTrackers = globalForUsage.usageTrackers ?? {
  free: createTracker(FREE_POINTS),
  pro: createTracker(PRO_POINTS),
};
if (process.env.NODE_ENV !== "production") globalForUsage.usageTrackers = usageTrackers;

export async function getUsageTracker() {
  const { has } = await auth();
  const hasProAccess = has({plan: "pro"});
  return hasProAccess ? usageTrackers.pro : usageTrackers.free;
};

export async function consumeCredits() {
  const { userId } = await auth();

  if (!userId) {
    throw new Error("User not authenticated");
  }

  const usageTracker = await getUsageTracker();
  const result = await usageTracker.consume(userId, GENERATION_COST);
  return result;
};

// Gives a credit back, e.g. when a generation fails. Doesn't use auth(), so it
// also works from Inngest where there is no request context.
export async function refundCredits(userId: string) {
  // The plan's point limit doesn't matter for giving points back
  await usageTrackers.pro.reward(userId, GENERATION_COST);
};

export async function getUsageStatus() {
  const { userId } = await auth();

  if (!userId) {
    throw new Error("User not authenticated");
  }

  const usageTracker = await getUsageTracker();
  const result = await usageTracker.get(userId);
  return result;
};