import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// next-intl without locale routing: German is the default (and for now only) locale (04-ui-ux §1).
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Docker image runs the standalone server (02 §1, 08 §3).
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // Server-only packages that must not be bundled by Turbopack/webpack.
  serverExternalPackages: ["@react-pdf/renderer", "pdfjs-dist", "pino"],
};

export default withNextIntl(nextConfig);
