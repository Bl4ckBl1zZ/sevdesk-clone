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
          include: ["convex/**/*.test.ts"],
          environment: "edge-runtime",
          setupFiles: ["./test/setup-invariants.ts"],
          server: { deps: { inline: ["convex-test"] } },
        },
      },
      {
        extends: true,
        test: {
          name: "server",
          include: ["src/*.test.ts", "src/app/api/**/*.test.ts", "src/server/**/*.test.ts", "scripts/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          include: ["src/components/**/*.test.tsx", "src/app/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./test/setup-ui.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
          setupFiles: ["./test/setup-invariants.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
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
