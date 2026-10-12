# convex/ — self-hosted Convex backend

Layout per 02 §3: `schema.ts` (tables from 03-data-model), `functions.ts` (wrappers: actor, role, audit,
triggers — every public function uses them), `model/` (the **only** place that calls
`ctx.db.insert/patch/replace/delete`; exception: `betterAuth/`), `<feature>.ts` (thin public functions),
`actions/`, `crons.ts`, `http.ts`, `_generated/` (committed).

## Backend for codegen, deploy and integration tests

`convex codegen` needs a running backend as soon as `convex.config.ts` exists. Without Docker:

```bash
scripts/convex-local-backend.sh &                                  # official precompiled backend on :3210/:3211
eval "$(scripts/convex-local-backend.sh env | sed 's/^/export /')" # CONVEX_SELF_HOSTED_URL/_ADMIN_KEY
pnpm convex dev          # or: pnpm convex codegen / pnpm convex deploy --yes
```

With Docker use `deploy/compose.dev.yml` (08 §10). Never point the CLI at Convex Cloud.

## Tests

`*.test.ts` here run in the Vitest project `convex` (edge-runtime + convex-test). Use `makeT()` from
`test.setup.ts`. `assertInvariants()` runs after every test (`test/setup-invariants.ts`).
`mutationInventory.test.ts` is the GOBD-06 mutation-inventory test.
