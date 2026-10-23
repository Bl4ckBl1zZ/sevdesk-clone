import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice, settle } from "./invoices.fixtures";
import { assignDatevAccounts } from "./model/datev";
import { type GdpduSource, gdpduMeta, gdpduSourcePage, startGdpduExport } from "./model/gdpdu";
import { createJob } from "./model/jobs";
import { postJournalEntry } from "./model/journal";
import { bookedTransaction } from "./payments.fixtures";
import { makeT, type TestT } from "./test.setup";

/** F09 EXP-017…EXP-019 GDPdU source pages (database side) and package metadata. */

const NOW = new Date("2026-10-12T10:00:00Z");
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const pageOf = (t: TestT, source: GdpduSource, includeFiles = true, year = 2026) =>
  t.run((ctx) => gdpduSourcePage(ctx, { source, year, cursor: null, includeFiles, now: Date.now() }));

describe("GDPdU source pages (EXP-017, EXP-019)", { timeout: 60_000 }, () => {
  test("EXP-019 without company data the firma page is empty and the Kontenrahmen falls back to SKR03; the metadata names no supplier", async () => {
    const t = makeT();
    const firma = await pageOf(t, "firma");
    expect(firma.rows["firma.csv"]).toEqual([]);
    expect(firma.db).toEqual({ "firma.csv": 0 });
    expect(firma.rows["konten.csv"]?.length).toBeGreaterThan(0);
    expect(firma.isDone).toBe(true);
    const jobId = await t.model(OWNER, (ctx) =>
      createJob(ctx, {
        kind: "gdpdu_export",
        label: "GDPdU-Export 2025",
        params: { year: 2025, encoding: "utf8", includeFiles: false },
        total: 10,
      }),
    );
    const meta = await t.run((ctx) => gdpduMeta(ctx, jobId, Date.now()));
    expect(meta).toMatchObject({
      year: 2025,
      range: { from: "2025-01-01", to: "2025-12-31" },
      supplier: { name: "—", location: "—" },
      restrictedContacts: 0,
      purges: [],
    });
  });

  test("EXP-017 package metadata is only read for an open GDPdU job; a future year cannot be started", async () => {
    const t = makeT();
    const csvJob = await t.model(OWNER, (ctx) =>
      createJob(ctx, { kind: "csv_export", label: "CSV", params: { list: "documents", variant: "excel" }, total: 1 }),
    );
    expect(await t.run((ctx) => gdpduMeta(ctx, csvJob, Date.now()))).toBeNull();
    const err = await t
      .model(OWNER, (ctx) => startGdpduExport(ctx, { year: 1999, encoding: "utf8", includeFiles: false }))
      .catch((e: unknown) => e);
    expect((err as { data?: { message?: string } }).data?.message).toBe(
      "Bitte ein Wirtschaftsjahr zwischen 2000 und dem laufenden Jahr wählen.",
    );
    const half = await t
      .model(OWNER, (ctx) => startGdpduExport(ctx, { year: 2025.5, encoding: "utf8", includeFiles: false }))
      .catch((e: unknown) => e);
    expect((half as { data?: { code?: string } }).data?.code).toBe("invalid_input");
  });

  test("EXP-017 E-EXP-32 company versions, contacts with personal accounts, the cash journal and its opening balance", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    await t.model(OWNER, (ctx) =>
      assignDatevAccounts(ctx, [
        { contactId: f.orgId, kind: "debtor" },
        { contactId: f.orgId, kind: "creditor" },
      ]),
    );
    await t.model(OWNER, (ctx) =>
      postJournalEntry(ctx, {
        kind: "opening_balance",
        fiscalYear: 2026,
        date: "2026-01-01",
        part: { kind: "cash", amountCents: 50_000 },
      }),
    );
    const firma = await pageOf(t, "firma");
    expect(firma.rows["firma.csv"]?.length).toBeGreaterThan(0);
    const kontakte = await pageOf(t, "kontakte");
    expect(kontakte.db["kontakte.csv"]).toBe(2);
    const konten = JSON.stringify(kontakte.rows["konten.csv"]);
    expect(konten).toContain("Debitor");
    expect(konten).toContain("Kreditor");
    const journal = await pageOf(t, "journal");
    const kasse = journal.rows["kassenbewegungen.csv"] ?? [];
    expect(kasse).toHaveLength(1);
    expect(kasse[0]).toMatchObject({ datum: "2026-01-01", betrag: 50_000, saldo: null, quelle_art: "opening_balance" });
    expect(journal.db["buchungszeilen.csv"]).toBe((journal.rows["buchungszeilen.csv"] ?? []).length);
    // the 2027 package opens the till with the 2026 balance
    const jobId = await t.model(OWNER, (ctx) =>
      createJob(ctx, {
        kind: "gdpdu_export",
        label: "GDPdU-Export 2027",
        params: { year: 2027, encoding: "ansi", includeFiles: true },
        total: 10,
      }),
    );
    const meta = await t.run((ctx) => gdpduMeta(ctx, jobId, Date.now()));
    expect(meta?.cash.cents).toBe(50_000);
    expect(meta?.cash.account).toBeTruthy();
    expect(meta?.supplier.name).not.toBe("—");
  });

  test("EXP-017 invoices: a Storno references the cancelled number; without files no paths; payments and bank rows of the year (ignored and other years excluded)", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    await f.owner.mutation(api.corrections.cancel, { id: f.id as Id<"salesDocuments"> });
    await settle(t);
    const withFiles = await pageOf(t, "rechnungen", true);
    expect(withFiles.db["rechnungen.csv"]).toBe(2);
    expect(withFiles.files.length).toBeGreaterThan(0);
    expect(JSON.stringify(withFiles.rows["rechnungen.csv"])).toContain(f.number);
    const noFiles = await pageOf(t, "rechnungen", false);
    expect(noFiles.files).toEqual([]);
    expect((noFiles.rows["dokumente.csv"] ?? []).length).toBe((withFiles.rows["dokumente.csv"] ?? []).length);
    const otherYear = await pageOf(t, "rechnungen", true, 2025);
    expect(otherYear.db["rechnungen.csv"]).toBe(0);

    await bookedTransaction(t, f.bankAccount, { bookingDate: "2026-10-01", amountCents: 1_000, purpose: "A" });
    await bookedTransaction(t, f.bankAccount, { bookingDate: "2026-10-02", amountCents: 2_000, purpose: "B" });
    await bookedTransaction(t, f.bankAccount, { bookingDate: "2025-12-31", amountCents: 3_000, purpose: "Vorjahr" });
    const bank = await pageOf(t, "bank");
    expect(bank.db["bankumsaetze.csv"]).toBe(2);
    const account = await t.run((ctx) => ctx.db.get(f.bankAccount));
    expect(JSON.stringify(bank.rows["bankumsaetze.csv"])).toContain(account?.iban as string);

    const numbers = await pageOf(t, "nummern");
    expect(numbers.db["nummernregister.csv"]).toBeGreaterThan(0);
    expect((await pageOf(t, "nummern", true, 2025)).db["nummernregister.csv"]).toBe(0);
    const log = await pageOf(t, "protokoll");
    expect(log.db["protokoll.csv"]).toBeGreaterThan(0);
    expect((await pageOf(t, "zahlungen")).db["zahlungen.csv"]).toBe(0);
  });

  test("EXP-017 vouchers: the originals are listed with and without the belege/ folder", async () => {
    vi.useRealTimers();
    const t = makeT();
    const { header, setupCompany, upload, YEAR } = await import("./vouchers.fixtures");
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const { voucherId } = await upload(t, owner);
    await owner.mutation(api.vouchers.updateDraft, { id: voucherId, input: header() });
    await owner.mutation(api.vouchers.finalize, { id: voucherId });
    await upload(t, owner); // a draft is not exported
    const withFiles = await pageOf(t, "eingangsbelege", true, YEAR);
    expect(withFiles.db["eingangsbelege.csv"]).toBe(1);
    expect(withFiles.db["eingangsbelegpositionen.csv"]).toBe(1);
    expect(withFiles.files).toHaveLength(1);
    expect(withFiles.files[0]?.path).toMatch(/^eingangsbelege\/BE-\d{4}-\d{5}_1\.pdf$/);
    const noFiles = await pageOf(t, "eingangsbelege", false, YEAR);
    expect(noFiles.files).toEqual([]);
    expect(noFiles.rows["dokumente.csv"]).toHaveLength(1);
  });
});

describe("GDPdU company history and job state (EXP-017, EXP-019)", { timeout: 60_000 }, () => {
  test("EXP-019 every company profile version is a firma row with the date it was superseded; a failed job has no package metadata", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    const { patchCompanyProfile } = await import("./model/companyProfile");
    vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(ctx, { name: "Muster Design GmbH (neu)" }, { action: "settings.company.update" }),
    );
    const versions = await t.run((ctx) => ctx.db.query("companyProfileVersions").collect());
    const firma = await pageOf(t, "firma");
    expect(firma.rows["firma.csv"]).toHaveLength(versions.length);
    expect(versions.length).toBeGreaterThan(1);
    expect(JSON.stringify(firma.rows["firma.csv"])).toContain("2026-10-13");

    const { failJob } = await import("./model/jobs");
    const jobId = await t.model(OWNER, (ctx) =>
      createJob(ctx, {
        kind: "gdpdu_export",
        label: "GDPdU-Export 2026",
        params: { year: 2026, encoding: "utf8", includeFiles: false },
        total: 10,
      }),
    );
    expect(await t.run((ctx) => gdpduMeta(ctx, jobId, Date.now()))).not.toBeNull();
    await t.model(OWNER, (ctx) => failJob(ctx, jobId, "Abbruch im Test"));
    expect(await t.run((ctx) => gdpduMeta(ctx, jobId, Date.now()))).toBeNull();
  });
});

describe("GDPdU bank rows of accounts without IBAN (EXP-017)", { timeout: 60_000 }, () => {
  test("EXP-017 a clearing account without IBAN is labelled with its name in bankumsaetze.csv", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const { auditedInsert } = await import("./model/audit");
    const card = await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankAccounts",
        {
          kind: "clearing",
          name: "Kreditkarte",
          currency: "EUR",
          accountHolder: "Muster",
          ledgerAccount: "1361",
          showOnInvoices: false,
          isDefaultForInvoices: false,
          autoApplyMatches: false,
        },
        { action: "settings.bank_account.create" },
      ),
    );
    await bookedTransaction(t, card, { bookingDate: "2026-10-03", amountCents: -2_500, purpose: "Software" });
    await bookedTransaction(t, f.bankAccount, { bookingDate: "2026-10-04", amountCents: 2_500, purpose: "Eingang" });
    const bank = await pageOf(t, "bank");
    expect(bank.db["bankumsaetze.csv"]).toBe(2);
    const rows = JSON.stringify(bank.rows["bankumsaetze.csv"]);
    expect(rows).toContain("Kreditkarte");
    const account = await t.run((ctx) => ctx.db.get(f.bankAccount));
    expect(rows).toContain(account?.iban as string);
  });
});
