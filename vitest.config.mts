import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Vitest 4.1 projects (07-testing §3.1). Pinned to 4.1.x until convex-test documents Vitest 5 (ADR-013).
 * Run one project: `pnpm test -p domain` (scripts/vitest.mjs maps -p to --project).
 */
export default defineConfig({
  plugins: [react()],
  // Vite 8 resolves tsconfig `paths` natively (replaces vite-tsconfig-paths from the 07 example).
  resolve: { tsconfigPaths: true },
  test: {
    globalSetup: ["./test/global-setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "domain",
          include: ["src/domain/**/*.test.ts", "test/golden/**/*.test.ts", "test/model/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "convex",
          // convex-test, PDF rendering and jsdom forms are CPU-heavy; on the shared dev host 5 s gave false failures.
          testTimeout: 20_000,
          include: ["convex/**/*.test.ts"],
          environment: "edge-runtime",
          setupFiles: ["./test/setup-invariants.ts"],
          server: { deps: { inline: ["convex-test", "@convex-dev/rate-limiter", "@convex-dev/better-auth"] } },
        },
      },
      {
        extends: true,
        test: {
          name: "server",
          // convex-test, PDF rendering and jsdom forms are CPU-heavy; on the shared dev host 5 s gave false failures.
          testTimeout: 20_000,
          include: [
            "src/*.test.ts",
            "src/app/api/**/*.test.ts",
            "src/server/**/*.test.ts",
            "src/lib/**/*.test.ts",
            "src/emails/**/*.test.ts",
            "scripts/**/*.test.ts",
            "src/pdf/**/*.test.{ts,tsx}",
            // REST/MCP route-handler tests against convex-test (outside src/: they import convex/test.setup).
            "test/server/**/*.test.ts",
          ],
          environment: "node",
          setupFiles: ["./test/setup-invariants.ts"],
          server: { deps: { inline: ["convex-test", "@convex-dev/rate-limiter", "@convex-dev/better-auth"] } },
          // `import "server-only"` throws outside the react-server condition; tests are server code.
          alias: { "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)) },
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          // convex-test, PDF rendering and jsdom forms are CPU-heavy; on the shared dev host 5 s gave false failures.
          testTimeout: 20_000,
          include: [
            "src/components/**/*.test.{ts,tsx}",
            "src/app/**/*.test.tsx",
            "src/hooks/**/*.test.{ts,tsx}",
            "src/i18n/**/*.test.{ts,tsx}",
          ],
          environment: "jsdom",
          setupFiles: ["./test/setup-ui.ts"],
        },
      },
      {
        // Deploy tooling, the Email Worker and the einvoice-tools sidecar (08 §3, 02 §8). No network, no Docker.
        extends: true,
        test: {
          name: "deploy",
          include: ["deploy/**/*.test.ts", "services/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
          setupFiles: ["./test/load-test-env.ts", "./test/setup-invariants.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          // The REST/MCP pipelines import "server-only" (see the server project).
          alias: { "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)) },
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      include: ["src/**/*.{ts,tsx}", "convex/**/*.ts"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
        "convex/_generated/**",
        "convex/test.setup.ts",
        "convex/convex.config.ts",
        "convex/betterAuth/**",
        "src/components/ui/**", // vendored shadcn primitives
        "src/app/**/{layout,page,loading,error,not-found}.tsx",
      ],
      // Coverage gates (07-testing §2). Floors, not goals.
      thresholds: {
        "src/domain/**": { lines: 95, branches: 90 },
        "convex/**": { lines: 85, branches: 80 },
        "src/app/api/**": { lines: 85, branches: 75 },
        "src/server/**": { lines: 85, branches: 75 },
        "src/components/**": { lines: 70 },
      },
    },
  },
});
