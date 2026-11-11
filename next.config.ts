import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // BUILD_DIST_DIR lets a production build run beside the dev server without
  // clobbering its .next directory (used only for verification builds).
  distDir: process.env.BUILD_DIST_DIR || ".next",
  // @libsql/client ships platform-specific natives; keep it external to the bundle.
  serverExternalPackages: ["@libsql/client", "libsql"],
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
