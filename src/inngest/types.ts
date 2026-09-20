// How long a sandbox stays alive after the last time the agent touches it (every
// getSandbox call resets it). Longer means previews stay usable for longer, and
// each generation's sandbox bills for longer; the E2B plan caps it at 1 hour.
export const SANDBOX_TIMEOUT = 60_000 * 30; // 30 minutes
