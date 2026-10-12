import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker image runs the standalone server (02 §1, 08 §3).
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // Server-only packages that must not be bundled by Turbopack/webpack.
  serverExternalPackages: ["@react-pdf/renderer", "pdfjs-dist", "pino"],
};

export default nextConfig;
