import { serve } from "inngest/next";

import { inngest } from "@/inngest/client";
import { codeAgentFunction } from "@/inngest/functions";

// Each Inngest step runs as one request. The app check step (load every page,
// then click through it in a browser) can take ~2.5 minutes, longer than
// Vercel's default limit; 300s is the most the Hobby plan allows.
export const maxDuration = 300;

// Create an API that serves zero functions
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    codeAgentFunction,
  ],
});
