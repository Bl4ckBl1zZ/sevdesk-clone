import { describe, expect, test } from "vitest";
import { parseCsv } from "../csv/csv";
import { computeEntryHash, genesisHash, verifyChainPage } from "./chain";
import {
  actorBadge,
  auditCsv,
  auditJson,
  chainStatus,
  combineFilters,
  type ExportEntry,
  matchesFilter,
  presetFilter,
} from "./viewer";

const row = (over: Partial<ExportEntry> = {}): ExportEntry => ({
  seq: 1,
  at: Date.parse("2026-10-12T08:00:00Z"),
  actor: "mcp:key1",
  channel: "mcp",
  action: "document.update_draft",
  entity: { table: "salesDocuments", id: "d1", label: "Entwurf" },
  prevHash: "p",
  hash: "h",
  ...over,
});

describe("audit viewer (F12 AUD-006)", () => {
  test("AUD-006 TST-AUD-19 „Was hat Claude heute geändert?“ = mcp actors since 00:00 Europe/Berlin, DST day included", () => {
    // 2026-10-25: clocks go back at 03:00 CEST; local midnight is 2026-10-24T22:00Z
    const now = Date.parse("2026-10-25T15:00:00Z");
    const f = presetFilter("claude_today", now);
    expect(f).toEqual({ actorKind: "mcp", from: Date.parse("2026-10-24T22:00:00Z"), to: now });
    expect(matchesFilter(row({ at: Date.parse("2026-10-24T22:00:00Z") }), f)).toBe(true);
    expect(matchesFilter(row({ at: Date.parse("2026-10-24T21:59:59Z") }), f)).toBe(false);
    expect(matchesFilter(row({ actor: "user:u1", channel: "ui", at: now - 1000 }), f)).toBe(false);
    // winter day: midnight is 23:00Z
    expect(presetFilter("claude_today", Date.parse("2026-12-01T10:00:00Z")).from).toBe(
      Date.parse("2026-11-30T23:00:00Z"),
    );
  });

  test("AUD-006 the other presets and filters select by action group, actor, channel, entity and text", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    expect(matchesFilter(row({ action: "settings.tax.update" }), presetFilter("settings", now))).toBe(true);
    expect(matchesFilter(row({ action: "document.delete_draft" }), presetFilter("deleted_drafts", now))).toBe(true);
    expect(matchesFilter(row({ action: "period.lock" }), presetFilter("locks", now))).toBe(true);
    expect(matchesFilter(row({ action: "auditor.access" }), presetFilter("auditor_access", now))).toBe(true);
    expect(matchesFilter(row({ action: "integrity.run" }), presetFilter("integrity", now))).toBe(true);
    expect(matchesFilter(row({ action: "export.datev" }), presetFilter("exports_imports", now))).toBe(true);
    expect(presetFilter("api_key", now, "api-key:k9")).toEqual({ actor: "api-key:k9" });
    const f = combineFilters(presetFilter("settings", now), { channel: "ui", text: "steuer" });
    expect(
      matchesFilter(
        row({
          action: "settings.tax.update",
          channel: "ui",
          entity: { table: "companyProfile", id: "c", label: "Steuern" },
        }),
        f,
      ),
    ).toBe(true);
    expect(matchesFilter(row({ action: "settings.tax.update", channel: "api" }), f)).toBe(false);
    expect(matchesFilter(row(), { entityTable: "salesDocuments", entityId: "d1" })).toBe(true);
    expect(matchesFilter(row(), { entityId: "d2" })).toBe(false);
  });

  test("AUD-006 actor badges: Du, name + role, API „key“, Claude (MCP), Prüfer, System; chain status per entry", () => {
    expect(actorBadge({ actor: "user:u1", actorRole: "owner" }, { viewerActor: "user:u1" }).label).toBe("Du");
    expect(actorBadge({ actor: "user:u2", actorRole: "bookkeeper", actorLabel: "anna@firma.de" }).label).toBe(
      "anna@firma.de (Buchhaltung)",
    );
    expect(actorBadge({ actor: "user:u3", actorRole: "auditor" })).toEqual({ kind: "auditor", label: "Prüfer" });
    expect(actorBadge({ actor: "api-key:k1" }, { keyName: "website" }).label).toBe("API „website“");
    expect(actorBadge({ actor: "mcp:k2" }).label).toBe("Claude (MCP)");
    expect(actorBadge({ actor: "system:cron.integrity.verify" }).label).toBe("System");
    const run = { lastVerifiedSeq: 40, at: Date.parse("2026-10-12T00:00:00Z"), ok: true };
    expect(chainStatus(40, run)).toEqual({ verified: true, text: "verifiziert bis seq 40 am 12.10.2026" });
    expect(chainStatus(41, run).verified).toBe(false);
    expect(chainStatus(1, null).text).toBe("Noch nicht geprüft");
  });
});

describe("audit export (F12 AUD-008)", () => {
  test("AUD-008 TST-AUD-20 the JSON export of a segment re-verifies with the chain rule and matches the checkpoint hash", async () => {
    let prevHash = await genesisHash("test");
    const entries: Record<string, unknown>[] = [];
    for (let seq = 1; seq <= 3; seq++) {
      const e: Record<string, unknown> = {
        seq,
        prevHash,
        at: 1_000 + seq,
        actor: "user:u1",
        channel: "ui",
        action: "contact.update",
        entity: { table: "contacts", id: `c${seq}` },
        diff: { after: { name: `=HYPERLINK("x")${seq}` } },
      };
      e.hash = await computeEntryHash(prevHash, e);
      prevHash = e.hash as string;
      entries.push({ _id: `id${seq}`, _creationTime: 1, ...e });
    }
    const segment = entries.slice(1);
    const json = JSON.parse(auditJson(segment, { instance: "test", exportedAt: 0, filter: { from: 1_002 } }));
    expect(json.entries[0]).not.toHaveProperty("_id");
    const first = json.entries[0];
    const res = await verifyChainPage(json.entries, { nextSeq: first.seq, prevHash: first.prevHash });
    expect(res.findings).toEqual([]);
    expect(res.lastVerifiedSeq).toBe(3);
    expect(json.entries.at(-1).hash).toBe(prevHash); // = checkpoint.lastHash for a checkpoint at seq 3

    const csv = auditCsv(segment as unknown as ExportEntry[]);
    const [header, line] = parseCsv(csv.replace(/^﻿/, ""));
    expect(header).toEqual(expect.arrayContaining(["seq", "prevHash", "hash", "diff"]));
    expect(line?.[header?.indexOf("hash") ?? -1]).toBe(entries[1]?.hash);
    // EXP-022: no cell starts with a formula character
    expect(csv).not.toMatch(/;=/);
  });
});
