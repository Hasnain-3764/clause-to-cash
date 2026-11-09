import type { NextConfig } from "next";

const config: NextConfig = {
  // Lets a DEMO_MODE dev server run next to the normal one.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Type checking runs separately (`npm run typecheck`, TypeScript 7).
  typescript: { ignoreBuildErrors: true },
  // Contract samples, fixtures and config are read from disk at runtime.
  outputFileTracingIncludes: { "/api/**": ["./contracts/**", "./fixtures/**", "./config/**"] },
};
export default config;
