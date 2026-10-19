import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { b2bBuyer, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { makeT, type TestT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};

const snapshotOf = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => {
    const d = await ctx.db.get(id);
    const s = d?.snapshotId ? await ctx.db.get(d.snapshotId) : null;
    return s ? (JSON.parse(s.json) as DocumentSnapshot) : null;
  });

describe("DOC-53 tags, custom fields and cost centres per document and line", { timeout: 30_000 }, () => {
  test("DOC-53 T-DOC-044 the line cost centre (else the document's) is frozen as KOST1 and a printable field is printed", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    await owner.mutation(api.lookups.saveCostCenter, {
      values: { number: "100", name: "Webdesign", isDefault: false },
    });
    await owner.mutation(api.lookups.saveCostCenter, { values: { number: "200", name: "Hosting", isDefault: false } });
    const centres = await owner.query(api.lookups.listCostCenters, {});
    const cc = (n: string) => centres.find((c) => c.number === n)?.costCenterId as string;
    await owner.mutation(api.lookups.saveTag, { values: { name: "Projekt Alpha" } });
    const tag = (await owner.query(api.lookups.listTags, {}))[0]?.tagId as string;
    for (const [key, label, printOnDocuments, required] of [
      ["projekt", "Projekt", true, true],
      ["intern", "Interne Notiz", false, false],
    ] as const) {
      await owner.mutation(api.lookups.createCustomField, {
        values: { entity: "document", key, label, type: "text", printOnDocuments, required },
      });
    }
    const base = invoiceValues(personId);
    const item = base.lines[0];
    if (item?.kind !== "item") throw new Error("item line expected");
    const values = {
      ...base,
      costCenterId: cc("100"),
      tags: [tag],
      customFields: { intern: "nur intern" },
      lines: [item, { ...item, name: "Hosting", costCenterId: cc("200") }],
    };
    const { id } = await owner.mutation(api.invoices.createDraft, { values });
    const stored = await t.run((ctx) => ctx.db.get(id));
    expect(stored).toMatchObject({ costCenterId: cc("100"), tags: [tag], customFields: { intern: "nur intern" } });

    // The required document field blocks finalisation, the draft itself saves.
    const blocked = await owner.action(api.invoices.finalize, { id, version: 1 }).catch((x: unknown) => x);
    expect(((dataOf(blocked).findings ?? []) as { code: string }[]).map((f) => f.code)).toContain(
      "custom_field_missing",
    );
    await owner.mutation(api.invoices.updateDraft, {
      id,
      version: 1,
      values: { ...values, customFields: { intern: "nur intern", projekt: "Relaunch 2026" } },
    });
    const detail = await owner.query(api.invoices.get, { id });
    expect((detail as { values?: { costCenterId?: string } } | null)?.values?.costCenterId).toBe(cc("100"));
    await owner.action(api.invoices.finalize, { id, version: 2 });
    await settle(t);
    const snap = await snapshotOf(t, id);
    const items = (snap?.lines ?? []).filter((l) => l.kind === "item") as { costCenter?: string }[];
    expect(items.map((l) => l.costCenter)).toEqual(["100", "200"]);
    expect(snap?.customFields).toEqual([{ label: "Projekt", value: "Relaunch 2026" }]);

    const unknown = await owner
      .mutation(api.invoices.createDraft, { values: { ...base, costCenterId: "x" } })
      .catch((x: unknown) => x);
    expect(dataOf(unknown).reason).toBe("COST_CENTER_UNKNOWN");
  });
});
