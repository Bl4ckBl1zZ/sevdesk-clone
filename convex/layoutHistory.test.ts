import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { b2bBuyer, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { makeT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SET-076 layout version history", { timeout: 30_000 }, () => {
  test("SET-076 lists versions with a diff summary and restores an old one as a new version", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    await owner.mutation(api.settings.saveLayout, { values: { template: "classic", accentColor: "#16a34a" } });
    const layoutId = (await owner.query(api.settings.listLayoutsWithDefaults, {})).find((l) =>
      l.isDefaultFor.includes("invoice"),
    )?.layoutId as Id<"layouts">;
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);

    await owner.mutation(api.settings.saveLayout, { values: { template: "modern", accentColor: "#1F6FEB" } });
    const history = await owner.query(api.settings.layoutHistory, { layoutId });
    expect(history.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(history.versions[0]).toMatchObject({
      current: true,
      usedBy: 0,
      summary: ["Vorlage: Klassisch → Modern", "Akzentfarbe: #16a34a → #1F6FEB"],
    });
    // The finalised invoice keeps version 1 (never deleted while referenced).
    expect(history.versions[1]).toMatchObject({ current: false, usedBy: 1 });

    const v1 = history.versions[1]?.versionId as Id<"layoutVersions">;
    expect(await owner.mutation(api.settings.restoreLayoutVersion, { layoutId, versionId: v1 })).toEqual({
      version: 3,
    });
    const after = await owner.query(api.settings.layoutHistory, { layoutId });
    expect(after.versions.map((v) => [v.version, v.current])).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ]);
    expect(after.versions[0]?.summary).toEqual(["Vorlage: Modern → Klassisch", "Akzentfarbe: #1F6FEB → #16a34a"]);
    const again = await owner
      .mutation(api.settings.restoreLayoutVersion, { layoutId, versionId: v1 })
      .catch((x: unknown) => x);
    expect(errorCode(again)).toBe("invalid_input");
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((a) => a.reason === "Wiederhergestellt aus Version 1")).toBe(true);
  });
});
