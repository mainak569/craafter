import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Loaded by Node at runtime instead of bundled: its optional Drizzle loader
  // makes webpack try to parse the package's .d.ts files.
  serverExternalPackages: ["rate-limiter-flexible"],
};

export default nextConfig;
