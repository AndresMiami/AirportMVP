import type { NextConfig } from "next";

// This app lives inside a larger repository that has its own lockfile at
// the root. Pin the build root here so Next never treats the repository
// root as the workspace (which would mis-trace files on Netlify).
const root = process.cwd();

const nextConfig: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default nextConfig;
