import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { IN_APP_TODO_KINDS, isCatalogKind, NOTIFICATION_KINDS } from "../../src/domain/notifications/catalog";

/**
 * F12 NTF-002 §4.8: every notification kind written anywhere in convex/ is either a catalog kind (severity,
 * channels, data-minimal text) or an explicitly listed in-app to-do kind. A new kind fails here until it is added to
 * src/domain/notifications/catalog.ts and to the F12 §4.8 table.
 */

function sources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "_generated" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) sources(p, acc);
    else if (p.endsWith(".ts") && !/\.(test|fixtures)\.ts$/.test(p) && !p.endsWith("test.setup.ts")) acc.push(p);
  }
  return acc;
}

function writtenKinds(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sources("convex")) {
    const src = readFileSync(file, "utf8");
    const consts = new Map([...src.matchAll(/const (\w+)(?::[^=]+)? = "([a-z0-9_.]+)"/g)].map((m) => [m[1], m[2]]));
    const add = (kind: string | undefined) => {
      if (kind) found.set(kind, file);
    };
    for (const m of src.matchAll(/notifyKind\(\s*ctx,\s*"([^"]+)"/g)) add(m[1]);
    for (const m of src.matchAll(/(?:\bnotify|upsertNotification)\(ctx, \{([\s\S]{0,600}?)\}\);/g)) {
      const body = m[1] ?? "";
      const lit = /\bkind: "([^"]+)"/.exec(body);
      const ident = /\bkind: ([A-Z_][A-Z0-9_]*)\b/.exec(body);
      if (lit) add(lit[1]);
      else if (ident) add(consts.get(ident[1] as string));
    }
    // kinds chosen from a map (`kind,` shorthand): `const NOTIFY_KIND = { … }`, `UST01_KINDS = { … }`
    for (const m of src.matchAll(/const \w*(?:NOTIFY_KIND|_KINDS)\b[^=]*= \{([^}]*)\}/g)) {
      for (const v of (m[1] ?? "").matchAll(/"([a-z0-9_.]+)"/g)) add(v[1]);
    }
  }
  return found;
}

describe("notification kinds (F12 §4.8, NTF-002)", () => {
  test("NTF-002 every kind written in convex/ is a catalog kind or a listed in-app to-do kind", () => {
    const todo = new Set<string>(IN_APP_TODO_KINDS);
    const kinds = writtenKinds();
    expect(kinds.size).toBeGreaterThan(30); // the scan really found the writers
    const unknown = [...kinds].filter(([k]) => !isCatalogKind(k) && !todo.has(k) && k !== "artifacts_blocked");
    expect(
      unknown,
      `Unkatalogisierte Benachrichtigungsarten: ${unknown.map(([k, f]) => `${k} (${f})`).join(", ")}`,
    ).toEqual([]);
  });

  test("NTF-002 dunning_reset and reminder_withdraw_suggested are catalog kinds with their F05 severities", () => {
    expect(NOTIFICATION_KINDS.dunning_reset).toMatchObject({
      severity: "warning",
      channels: { inApp: true, email: false },
    });
    expect(NOTIFICATION_KINDS.reminder_withdraw_suggested).toMatchObject({
      severity: "info",
      channels: { inApp: true, email: false, ntfy: false },
    });
    expect(NOTIFICATION_KINDS["restore_drill.failed"]).toMatchObject({
      severity: "error",
      channels: { inApp: true, email: true, ntfy: true },
    });
    // a to-do kind is never also a catalog kind
    expect(IN_APP_TODO_KINDS.filter((k) => isCatalogKind(k))).toEqual([]);
  });
});
