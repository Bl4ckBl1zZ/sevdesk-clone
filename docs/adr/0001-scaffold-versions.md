# ADR 0001 — Scaffold versions and deviations (P0)

- **Status:** accepted · 2026-10-12
- **Context:** 02 §2 pins the stack; this records what the P0 scaffold actually installed and where reality
  forced a choice. All npm dependencies are pinned exactly (no `^`/`~`).

## Versions

| Package | Version | Note |
|---|---|---|
| Node / pnpm | 24 / 12.11.2 | `packageManager` field, `.nvmrc` |
| next / react / react-dom | 16.4.0 / 19.3.0 / 19.3.0 | upgrade to the patch announced for 2026-10-14 |
| typescript | **6.0.3** | see deviation 1 |
| tailwindcss, @tailwindcss/postcss | 4.3.3 | |
| shadcn (CLI) / @base-ui/react | 4.21.4 / 1.9.0 | style `base-vega`, base color neutral — see deviation 2 |
| convex / convex-helpers / convex-test | 1.46.0 / 0.1.128 / 0.0.61 | |
| @convex-dev/better-auth / better-auth / @better-auth/passkey | 0.12.5 / 1.6.33 / 1.6.33 | exact; Renovate blocks better-auth ≥ 1.7 |
| @convex-dev/rate-limiter | 0.4.2 | |
| zod / zod-openapi / @scalar/nextjs-api-reference | 4.6.6 / 6.0.2 / 0.12.9 | |
| mcp-handler / @modelcontextprotocol/server / @modelcontextprotocol/client | 2.3.0 / 2.3.1 / 2.3.1 | SDK v2 as named in 06 §1 (not the legacy `@modelcontextprotocol/sdk` v1) |
| standardwebhooks | 1.1.1 | |
| @react-pdf/renderer / @cantoo/pdf-lib / @e-invoice-eu/core | 4.9.0 / 2.11.1 / 3.4.0 | |
| date-fns / @date-fns/tz | 4.4.0 / 1.5.0 | |
| vitest / @vitest/coverage-v8 | **4.1.11** | `V4` dist-tag; 5.0.4 is `latest` but ADR-013 pins 4.1 |
| vite / @vitejs/plugin-react | 8.3.4 / 6.1.2 | |
| @playwright/test / @axe-core/playwright | 1.64.0 / 4.13.0 | |
| msw / fast-check / jsdom / @edge-runtime/vm | 3.0.3 / 4.10.2 / 30.1.2 / 5.0.0 | |
| @stryker-mutator/core + vitest-runner | 10.0.0 | |
| @biomejs/biome | 2.5.15 | |
| @tanstack/react-table | 8.21.3 | 04 §2 says v8; v9 is `latest` |
| Convex backend (dev/CI binary) | `precompiled-2026-10-10-72ce13c` | matches the image SHA in research 11 |

## Deviations

1. **TypeScript 6.0.3 instead of 7.0.2.** TS 7 is the native (Go) port. Next 16.4's build-time type check loads
   the `typescript` package's JS API, which TS 7 changes, and Next 16.4 does not document TS 7 support (not tested
   here). 6.0.3 is the newest release of the JS implementation and works with `next build`, `tsc` and the Convex
   CLI. Revisit when Next documents TS 7 support.
2. **shadcn style `base-vega` instead of `new-york`.** shadcn CLI v4 with Base UI no longer offers `new-york`;
   `vega` is its successor look (classic shadcn). Base color `neutral`, CSS variables, lucide icons as specified.
   The CLI replaced `clsx` + `tailwind-merge` with its own `cn` package.
3. **No `vite-tsconfig-paths`.** Vite 8 resolves tsconfig `paths` natively (`resolve.tsconfigPaths: true`); the
   07 §3.1 example predates that.
4. **convex-test module glob.** Vite 8's `import.meta.glob` ignores the extglob `./**/!(*.*.*)*.*s` from the
   convex-test docs (returns nothing). `convex/test.setup.ts` uses `["./**/*.*s", "!./**/*.*.*s"]`.
5. **Architecture boundaries via a script, not ESLint.** 02 §2 mentions targeted ESLint rules; to avoid a second
   linter, `scripts/check-boundaries.ts` (unit-tested, part of `pnpm lint`) enforces the dependency rules and the
   "db writes only in `convex/model/**` + `convex/betterAuth/**`" rule. Biome's `noRestrictedImports` mirrors the
   import part for `src/domain/**` for editor feedback.
6. **No Docker on the dev machine.** `scripts/convex-local-backend.sh` runs the official precompiled self-hosted
   backend binary (same release as the pinned image) for codegen, `convex deploy` and the `integration` project.
   The CI `integration` job uses it too until `deploy/compose.dev.yml` exists. It uses SQLite, not Postgres 17.
7. **`pnpm test -p <project>`.** Vitest has no `-p` shorthand; `scripts/vitest.mjs` maps `-p a,b` to
   `--project a --project b` so the CLAUDE.md commands work.
8. **Playwright.** `baseURL` comes from `E2E_BASE_URL`; without it Playwright starts `next dev` (local) or
   `build && start` (CI). Auth `storageState`/`globalSetup` follow with the login work. Locally only Chromium
   projects (desktop, pixel) run: WebKit (iphone) needs system libraries that require root
   (`pnpm exec playwright install-deps webkit`).
9. **`next-env.d.ts` is gitignored**; `pnpm typecheck` runs `next typegen` first.
