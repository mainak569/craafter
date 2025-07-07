import { inngest } from "./client";

export const helloWorld = inngest.createFunction(
  { id: "hello-world" },
  { event: "test/hello.world" },
  async ({ event, step }) => {
    await step.sleep("search", "10s");
    await step.sleep("reading", "30s");
    await step.sleep("summarize", "5s");
    return { message: `Hello ${event.data.email}!` };
  },
);
