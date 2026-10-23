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

describe("bulk actions on drafts (VOU-101)", () => {
  test("VOU-101 bulk set account / tax rule / cost centre on drafts; booked vouchers and disallowed accounts are skipped", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const a = await draft(t, owner);
    const b = await draft(t, owner, { supplierName: "Telekom Deutschland GmbH", supplierVatId: "DE811907980" });
    const booked = await draft(t, owner, { supplierName: "Shell Deutschland", supplierVatId: "DE111111125" });
    await owner.mutation(api.vouchers.finalize, { id: booked });
    const r = await owner.mutation(api.vouchers.bulkUpdate, {
      ids: [a, b, booked],
      patch: { account: "6815", taxRule: "no_input_vat", costCenterId: "kst-1" },
    });
    expect(r.updated).toEqual([a, b]);
    expect(r.skipped).toEqual([
      { id: booked, label: expect.any(String), reason: expect.stringContaining("Nur Entwürfe") },
    ]);
    for (const id of [a, b]) {
      const v = await voucher(t, id);
      expect(v.taxRule).toBe("no_input_vat");
      expect(v.version).toBeGreaterThan(1);
      const lines = await t.run((ctx) =>
        ctx.db
          .query("voucherLines")
          .withIndex("by_voucher", (q) => q.eq("voucherId", id))
          .collect(),
      );
      expect(lines.map((l) => [l.account, l.costCenterId, l.grossCents])).toEqual([["6815", "kst-1", 11_900]]);
    }
    // A revenue account is not allowed on expense drafts (EC-VOU-37): nothing changes.
    const bad = await owner.mutation(api.vouchers.bulkUpdate, { ids: [a], patch: { account: "4400" } });
    expect(bad.updated).toEqual([]);
    expect(bad.skipped[0]?.reason).toContain("Das Konto 4400 ist für Ausgaben");
  });

  test("VOU-101 T06-131 „Sammelbuchung“ runs as a job: books drafts without blocking errors, skips and lists the others", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const ok = await draft(t, owner);
    const noFile = await owner.mutation(api.vouchers.create, {
      input: { ...header({ supplierName: "Ohne Datei GmbH", supplierVatId: "DE811907980" }) },
    });
    const flagged = await draft(t, owner, {
      supplierName: "Groß GmbH",
      supplierVatId: undefined,
      lines: [{ account: "6805", description: "Server", amountCents: 59_500, vatRateBp: 1900 }],
    });
    const { jobId } = await owner.mutation(api.vouchers.startBulkFinalize, { ids: [ok, noFile, flagged] });
    await t.finishAllScheduledFunctions(() => {});
    const job = await t.run((ctx) => ctx.db.get(jobId));
    expect(job).toMatchObject({ kind: "voucher_bulk_finalize", status: "done", progress: { done: 3, total: 3 } });
    expect(job?.skipped?.map((s) => s.id)).toEqual([noFile, flagged]);
    expect(job?.skipped?.[0]?.reason).toContain("Jede Buchung braucht einen Beleg");
    expect(job?.skipped?.[1]?.reason).toMatch(/^Bitte einzeln prüfen und bestätigen: Vorsteuerabzug gefährdet/);
    expect((await voucher(t, ok)).status).toBe("open");
    expect((await voucher(t, noFile)).status).toBe("draft");
    expect((await voucher(t, flagged)).status).toBe("draft");
    // The booking is attributed to the member who started the job.
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "voucher.finalize"))
        .collect(),
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((x) => x.actor.startsWith("user:"))).toBe(true);
  });

  test("VOU-101 bulk delete removes drafts only", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const d1 = await draft(t, owner);
    const booked = await draft(t, owner, { supplierName: "Telekom Deutschland GmbH", supplierVatId: "DE811907980" });
    await owner.mutation(api.vouchers.finalize, { id: booked });
    const r = await owner.mutation(api.vouchers.bulkDelete, { ids: [d1, booked] });
    expect(r.deleted).toEqual([d1]);
    expect(r.skipped[0]?.reason).toBe("Gebuchte Belege können nicht gelöscht werden.");
    expect(await t.run((ctx) => ctx.db.get(d1))).toBeNull();
    expect((await voucher(t, booked)).status).toBe("open");
  });
});

describe("private vouchers (VOU-066)", () => {
  test("VOU-066 a private voucher books S Privatentnahmen · H Verbindlichkeiten (no expense, no input VAT); GmbH blocked", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, { kind: "private" });
    const r = await owner.mutation(api.vouchers.finalize, { id });
    expect(r.infos.map((i) => i.code)).toContain("private_no_input_vat");
    expect((await voucher(t, id)).taxRule).toBe("no_input_vat");
    const [entry] = await t.run((ctx) =>
      ctx.db
        .query("journalEntries")
        .withIndex("by_source", (q) => q.eq("source.kind", "voucher").eq("source.id", id))
        .collect(),
    );
    expect(entry?.explanation).toBe("V-private");
    expect(entry?.lines.map((l) => [l.account, l.debitCents, l.creditCents])).toEqual([
      ["2100", 11_900, 0],
      ["3300", 0, 11_900],
    ]);

    const g = makeT();
    await setupCompany(g, { legalForm: "gmbh" });
    const gOwner = await g.asUser("owner");
    const gid = await draft(g, gOwner, { kind: "private" });
    const e = await gOwner.mutation(api.vouchers.finalize, { id: gid }).catch((x: unknown) => x);
    expect((e as { data?: { message?: string } }).data?.message).toContain(
      "Kapitalgesellschaften haben kein Privatkonto",
    );
    expect((await voucher(g, gid)).status).toBe("draft");
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
