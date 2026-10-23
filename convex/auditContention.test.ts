import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BATCH as CSV_BATCH } from "./csvImports";
import { CONTACT_BATCH, DOCUMENT_BATCH, PRODUCT_BATCH } from "./imports";
import { setupInvoicing } from "./invoices.fixtures";
import { makeT } from "./test.setup";

/** F12 E-AUD-18: bulk imports write in batches of ≤ 100 records per mutation; the audit chain stays gapless. */

describe("audit write contention (E-AUD-18)", () => {
  test("E-AUD-18 bulk imports commit ≤ 100 records per mutation and 230 imported contacts leave a gapless, verifying chain", async () => {
    for (const size of [CSV_BATCH, CONTACT_BATCH, PRODUCT_BATCH, DOCUMENT_BATCH]) {
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThanOrEqual(100);
    }

    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const lines = ["Kundennummer;Firma;Ort"];
    for (let i = 0; i < 230; i++) lines.push(`B-${1000 + i};Firma ${i} GmbH;Berlin`);
    const importId: Id<"imports"> = await owner.mutation(api.csvImports.create, {});
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([`${lines.join("\n")}\n`])));
    await owner.action(api.csvImports.setFile, { importId, storageId, name: "viele.csv", target: "contacts" });
    await owner.mutation(api.csvImports.setMapping, {
      importId,
      columns: { number: "Kundennummer", organizationName: "Firma", city: "Ort" },
      preset: "Viele",
      savePreset: false,
    });
    const p = await owner.action(api.csvImports.preview, { importId });
    expect(p.preview.counts).toMatchObject({ new: 230 });
    const r = await owner.action(api.csvImports.commit, { importId, previewHash: p.previewHash });
    expect(r).toMatchObject({ status: "done", created: 230 });

    const audit = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").collect());
    expect(audit.filter((a) => a.action === "import.record")).toHaveLength(230);
    expect(audit.every((a, i) => a.seq === i + 1)).toBe(true);
    const verify = await t.action(internal.integrity.verify, {});
    expect(verify).toMatchObject({ ok: true, findings: [] });
  });
});
