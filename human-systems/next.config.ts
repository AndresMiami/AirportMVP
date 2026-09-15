import type { NextConfig } from "next";

// This app lives inside a larger repository that has its own lockfile at
// the root. Pin the build root here so Next never treats the repository
// root as the workspace.
const root = process.cwd();

const nextConfig: NextConfig = {
  // Every screen is static and all data lives in the browser, so the site
  // is exported as plain HTML files (out/). Netlify serves them directly;
  // no server runtime is involved. `next dev` keeps working as usual.
  output: "export",
  trailingSlash: true,
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default nextConfig;
