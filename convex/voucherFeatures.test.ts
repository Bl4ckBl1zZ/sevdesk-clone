/**
 * F06 SHOULD/COULD voucher features: „Vollständig geprüft“ / „Papier vernichtbar“ (VOU-123), image quality (VOU-124).
 */
import { describe, expect, test } from "vitest";
import { VD_CHAPTERS } from "../src/domain/docs/verfahrensdoku";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { makeT, type TestT } from "./test.setup";
import { header, setupCompany, upload } from "./vouchers.fixtures";

type Owner = Awaited<ReturnType<TestT["asUser"]>>;
const voucher = (t: TestT, id: Id<"vouchers">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"vouchers">>;

async function draft(t: TestT, owner: Owner, over: Record<string, unknown> = {}, bytes?: Uint8Array) {
  const { voucherId } = await upload(t, owner, bytes ? { bytes, name: "foto.png" } : {});
  await owner.mutation(api.vouchers.updateDraft, { id: voucherId, input: header(over) });
  return voucherId;
}

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
/** PNG signature + IHDR (no image data needed for the header check) + a unique trailer. */
const png = (w: number, h: number, seed: string) =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...[..."IHDR"].map((c) => c.charCodeAt(0)),
    ...be32(w),
    ...be32(h),
    8,
    2,
    0,
    0,
    0,
    ...new TextEncoder().encode(seed),
  ]);

const paperTab = (owner: Owner) =>
  owner.query(api.vouchers.list, { paginationOpts: { numItems: 20, cursor: null }, tab: "paper_destructible" });

describe("„Vollständig geprüft“ and „Papier vernichtbar“ (VOU-123, GOBD-08, GOBD-10)", () => {
  test("VOU-123 T06-137 the check records actor and time; the filter appears only with a released scanning procedure", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const booked = await draft(t, owner);
    await owner.mutation(api.vouchers.finalize, { id: booked });
    const unchecked = await draft(t, owner, { supplierName: "Telekom Deutschland GmbH", supplierVatId: "DE811907980" });
    await owner.mutation(api.vouchers.finalize, { id: unchecked });
    const draftChecked = await draft(t, owner);

    await owner.mutation(api.vouchers.checkedComplete, { id: booked });
    await owner.mutation(api.vouchers.checkedComplete, { id: draftChecked });
    const v = await voucher(t, booked);
    expect(v.checkedComplete?.actor).toMatch(/^user:/);
    expect(typeof v.checkedComplete?.at).toBe("number");
    // Marking again keeps the first record.
    await owner.mutation(api.vouchers.checkedComplete, { id: booked });
    expect((await voucher(t, booked)).checkedComplete).toEqual(v.checkedComplete);

    // Without a released Verfahrensdokumentation there is no „Papier vernichtbar“.
    const before = await owner.query(api.vouchers.counts, {});
    expect(before.paperDestructibleAvailable).toBe(false);
    expect(before.paper_destructible).toBe(0);
    expect((await paperTab(owner)).page).toEqual([]);

    const values = Object.fromEntries(
      VD_CHAPTERS.flatMap((c) => c.fields.filter((f) => f.required).map((f) => [f.key, "erledigt"])),
    );
    await owner.mutation(api.verfahrensdoku.saveInputs, { values });
    await owner.action(api.verfahrensdoku.release, {});

    const after = await owner.query(api.vouchers.counts, {});
    expect(after.paperDestructibleAvailable).toBe(true);
    expect(after.paper_destructible).toBe(1);
    const rows = (await paperTab(owner)).page;
    expect(rows.map((r) => r._id)).toEqual([booked]);
    expect(rows[0]?.checkedComplete).toBe(true);
  });
});

describe("image quality (VOU-124, GOBD-08)", () => {
  test("VOU-124 T06-138 a low-resolution photo is stored with „Bildqualität niedrig“ and „Neu aufnehmen“ replaces it", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, {}, png(800, 1200, "low"));
    const v = await voucher(t, id);
    expect(v.originalFiles[0]?.image).toEqual({ width: 800, height: 1200, estimatedDpi: 103, low: true });
    const detail = await owner.query(api.vouchers.get, { id });
    expect(detail?.files[0]?.qualityWarning).toBe(
      "Bildqualität niedrig (800 × 1200 Pixel, ca. 103 dpi). Der Beleg ist möglicherweise nicht vollständig lesbar – bitte neu aufnehmen.",
    );
    // „Neu aufnehmen“ = replacing the original (draft: no reason); the new capture is fine, the old stays retrievable.
    await upload(t, owner, { voucherId: id, bytes: png(3024, 4032, "good"), name: "foto2.png", replaceIndex: 0 });
    const after = await owner.query(api.vouchers.get, { id });
    expect(after?.files.map((f) => [f.replacedBy, f.qualityWarning])).toEqual([
      [1, expect.any(String)],
      [null, null],
    ]);
    // PDFs are not measured.
    const pdf = await draft(t, owner);
    expect((await voucher(t, pdf)).originalFiles[0]?.image).toBeUndefined();
  });
});

describe("„Mit Banking-App bezahlen“ (VOU-135, MISC-01)", () => {
  test("VOU-135 the detail of an open voucher carries the GiroCode (open amount, supplier IBAN, document number); none once paid", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, { supplierIban: "DE02120300000000202051", documentNumber: "RE-77" });
    expect((await owner.query(api.vouchers.get, { id }))?.girocode).toBeNull(); // draft
    await owner.mutation(api.vouchers.finalize, { id });
    const code = (await owner.query(api.vouchers.get, { id }))?.girocode;
    expect(code?.split("\n")).toEqual([
      "BCD",
      "002",
      "1",
      "SCT",
      "",
      "Büro Schmidt GmbH",
      "DE02120300000000202051",
      "EUR119.00",
      "",
      "",
      "RE-77",
    ]);
    await owner.mutation(api.vouchers.recordPayment, { id, method: "private" });
    expect((await owner.query(api.vouchers.get, { id }))?.girocode).toBeNull();
  });
});
