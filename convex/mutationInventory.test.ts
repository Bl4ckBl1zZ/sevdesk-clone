/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { WRAPPER_TAG, type WrapperMeta } from "./functions";

/**
 * Mutation inventory (07-testing §5, GOBD-06, CLAUDE.md rules 3 and 6).
 *
 * 1. Static: no module outside convex/model/** and convex/betterAuth/** (the Better Auth component's own tables)
 *    calls ctx.db writes (same rule as scripts/check-boundaries.ts, repeated so the Convex suite fails on its own).
 * 2. Every registered app function is built with a wrapper from convex/functions.ts (actor, permission/job, audit
 *    check). Raw builders are allowed only for the listed exceptions.
 * 3. The inventory (convex/mutation-inventory.json: name → kind, visibility, wrapper, permission/job) is a file
 *    snapshot: a new, removed or re-permissioned function fails until the snapshot is updated on purpose with
 *    `pnpm test -p convex convex/mutationInventory.test.ts -u` (review the diff).
 * 4. Once finalised documents, payments, journal entries etc. exist (P1+), each public mutation is called against
 *    them and must throw `immutable_record` (todo below).
 */
const sources = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./_generated/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const modules = import.meta.glob(["./**/*.ts", "!./**/*.*.ts", "!./_generated/**", "!./betterAuth/**"], {
  eager: true,
}) as Record<string, Record<string, unknown>>;

const WRITE_RE = /\bdb\s*\.\s*(insert|patch|replace|delete)\s*\(/;
const ALLOWED_WRITERS = [/^\.\/model\//, /^\.\/betterAuth\//];

/** Registered with raw builders on purpose (each with a reason). */
const RAW_ALLOWLIST: Record<string, string> = {
  "auth:onCreate":
    "Better Auth component trigger entry (triggersApi); every trigger body runs via asModel() as system:auth",
  "auth:onUpdate": "Better Auth component trigger entry (triggersApi)",
  "auth:onDelete": "Better Auth component trigger entry (triggersApi)",
  "access:resolveForAction": "internal read used by the action wrapper itself to resolve the actor",
};

type RegisteredFn = {
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  isHttp?: boolean;
  isPublic?: boolean;
  isInternal?: boolean;
  [WRAPPER_TAG]?: WrapperMeta;
};

interface InventoryRow {
  kind: "query" | "mutation" | "action";
  visibility: "public" | "internal";
  wrapper: WrapperMeta["wrapper"] | "raw";
  permission?: string;
  job?: string;
}

function registered(): Record<string, InventoryRow> {
  const rows: Record<string, InventoryRow> = {};
  for (const [path, mod] of Object.entries(modules)) {
    for (const [exportName, value] of Object.entries(mod)) {
      if (typeof value !== "function") continue;
      const fn = value as RegisteredFn;
      const kind = fn.isQuery ? "query" : fn.isMutation ? "mutation" : fn.isAction ? "action" : undefined;
      if (!kind) continue;
      const name = `${path.replace(/^\.\//, "").replace(/\.ts$/, "")}:${exportName}`;
      const meta = fn[WRAPPER_TAG];
      rows[name] = {
        kind,
        visibility: fn.isPublic ? "public" : "internal",
        wrapper: meta?.wrapper ?? "raw",
        ...(meta?.permission ? { permission: meta.permission } : {}),
        ...(meta?.job ? { job: meta.job } : {}),
      };
    }
  }
  return Object.fromEntries(Object.entries(rows).sort(([a], [b]) => a.localeCompare(b)));
}

describe("mutation inventory", () => {
  test("GOBD-06 no Convex module outside convex/model/** writes to ctx.db", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !ALLOWED_WRITERS.some((re) => re.test(path)) && path !== "./test.setup.ts")
      .filter(([, src]) => WRITE_RE.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  test("AUD-001 every public function is built with a wrapper that declares a permission", () => {
    const rows = registered();
    const publicRows = Object.entries(rows).filter(([, r]) => r.visibility === "public");
    expect(publicRows.length).toBeGreaterThan(0);
    const bad = publicRows
      .filter(([, r]) => !["query", "mutation", "action"].includes(r.wrapper) || !r.permission)
      .map(([n]) => n);
    expect(bad).toEqual([]);
  });

  test("AUD-001 internal functions use system/actor wrappers (attributed) unless explicitly allowlisted", () => {
    const rows = registered();
    const raw = Object.entries(rows)
      .filter(([, r]) => r.wrapper === "raw")
      .map(([n]) => n);
    expect(raw.sort()).toEqual(Object.keys(RAW_ALLOWLIST).sort());
    for (const [name, r] of Object.entries(rows)) {
      if (r.wrapper === "systemQuery" || r.wrapper === "systemMutation" || r.wrapper === "systemAction") {
        expect(r.job, name).toBeDefined();
        expect(r.visibility, name).toBe("internal");
      }
      if (r.wrapper === "actorMutation") expect(r.visibility, name).toBe("internal");
    }
  });

  test("AUD-001 the function inventory matches convex/mutation-inventory.json", async () => {
    await expect(`${JSON.stringify(registered(), null, 2)}\n`).toMatchFileSnapshot("./mutation-inventory.json");
  });

  test("GOBD-06 the Better Auth component writes only its own tables", () => {
    const authSources = Object.entries(sources).filter(([p]) => p.startsWith("./betterAuth/"));
    const appTables = [
      "auditLog",
      "members",
      "invites",
      "integrityCheckpoints",
      "integrityRuns",
      "contactKeys",
      "apiKeys",
      "companyProfile",
    ];
    for (const [path, src] of authSources) {
      for (const table of appTables) expect(src.includes(`"${table}"`), `${path} references ${table}`).toBe(false);
    }
  });

  test.todo("GOBD-06 every public mutation rejects changes to finalised records with immutable_record (P1)");
});
