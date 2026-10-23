/// <reference types="vite/client" />
import { describe, expect, test, vi } from "vitest";
import camtOct from "../test/fixtures/bank/revolut-statements/synthetic-2026-10/eur-2026-10.camt053.xml?raw";
import csvOct from "../test/fixtures/bank/revolut-statements/synthetic-2026-10/eur-2026-10.csv?raw";
import usdOct from "../test/fixtures/bank/revolut-statements/synthetic-2026-10/usd-2026-10.camt053.xml?raw";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { settle } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert, auditedPatch } from "./model/audit";
import { applyAllocation, unmatchedTransactions } from "./model/bankTransactions";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";

// Outbound events are emitted on import/mark: the SSRF guard must never resolve DNS for real.
vi.mock("./lib/webhookDns", () => ({ resolveHost: async () => ["93.184.216.34"] }));

/**
 * F07 banking branch coverage (BNK-020…036, BNK-060…064, BNK-120…122): the transaction list filters and detail
 * sheet, the statement import guards, the archive views, possible duplicates, marking and unmarking guards, the
 * import rollback and the allocation hook. Every refusal is asserted with its German message or reason code.
 */

const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
const IBAN = "LT443250010000000101";
const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;
const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message ?? String(e);

async function setup(legalForm: "einzelunternehmen" | "gmbh" = "einzelunternehmen") {
  const t = makeT();
  await t.model(OWNER, (ctx) =>
    patchCompanyProfile(
      ctx,
      {
        name: legalForm === "gmbh" ? "Muster Consulting GmbH" : "Muster Consulting e.K.",
        legalForm,
        address: {
          name: "Muster Consulting",
          street: "Hauptstr. 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
        },
        chartOfAccounts: [{ validFromFiscalYear: 2026, chart: "SKR03" }],
        taxationMethod: [{ validFrom: "2026-01-01", method: "soll" }],
        ustvaPeriod: [{ year: 2026, period: "monthly", dauerfrist: false }],
      },
      { action: "settings.tax.update" },
    ),
  );
  const owner = await t.asUser("owner");
  const account = (currency: string) =>
    owner.mutation(api.banking.createAccount, {
      values: {
        name: `Revolut ${currency}`,
        currency,
        iban: IBAN,
        bic: "",
        accountHolder: "Max Muster",
        showOnInvoices: false,
      },
    });
  const eur = await account("EUR");
  const usd = await account("USD");
  return { t, owner, eur, usd };
}
type S = Awaited<ReturnType<typeof setup>>;

const store = (t: TestT, content: string, type: string) =>
  t.run((ctx) => ctx.storage.store(new Blob([content], { type })));

async function importFile(s: S, accountId: Id<"bankAccounts">, content: string, fileName: string, pdf = false) {
  const storageId = await store(s.t, content, "application/octet-stream");
  const pdfStorageId = pdf ? await store(s.t, "%PDF-1.7 signed statement", "application/pdf") : undefined;
  const r = await s.owner.action(api.banking.commitImport, {
    accountId,
    storageId,
    fileName,
    ...(pdfStorageId ? { pdfStorageId, pdfName: "Kontoauszug.pdf" } : {}),
  });
  // The import schedules the BNK-050 rules / BNK-043 auto-apply: let them finish before the test continues.
  await settle(s.t);
  return r;
}

const rows = (t: TestT, accountId: Id<"bankAccounts">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("bankTransactions")
      .withIndex("by_account_bookingDate", (q) => q.eq("accountId", accountId))
      .collect(),
  );

const byRef = (list: Doc<"bankTransactions">[], n: string) =>
  list.find(
    (r) =>
      r.source.entryReference?.endsWith(`-0000000000${n}`) ||
      r.source.providerTransactionId?.endsWith(`-0000000000${n}`),
  ) as Doc<"bankTransactions">;

/** A row id that no longer exists (inserted, then removed outside the model layer). */
async function goneTransaction(s: S): Promise<Id<"bankTransactions">> {
  const list = await rows(s.t, s.eur);
  const any = list[0] as Doc<"bankTransactions">;
  const id = await s.t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankTransactions",
      {
        ...Object.fromEntries(Object.entries(any).filter(([k]) => !k.startsWith("_"))),
        dedupeKey: `${s.eur}:gone`,
        status: "open",
        allocatedCents: 0,
      } as never,
      { action: "bank.import" },
    ),
  );
  await s.t.run((ctx) => ctx.db.delete(id));
  return id;
}

const PAGE = { numItems: 50, cursor: null };

describe("F07 accounts and the transaction list (BNK-001, BNK-120)", () => {
  test("BNK-001 the account view returns null for an unknown id and IBAN null for a clearing account; invalid input names the field", async () => {
    const s = await setup();
    expect(await s.owner.query(api.banking.account, { id: s.eur })).toEqual({
      id: s.eur,
      name: "Revolut EUR",
      currency: "EUR",
      iban: IBAN,
      archived: false,
    });
    const clearing = await s.t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankAccounts",
        {
          kind: "paypal",
          name: "PayPal",
          currency: "EUR",
          accountHolder: "Max Muster",
          ledgerAccount: "1220",
          showOnInvoices: false,
          isDefaultForInvoices: false,
          autoApplyMatches: false,
          archivedAt: Date.now(),
        },
        { action: "settings.bank_account.create" },
      ),
    );
    expect(await s.owner.query(api.banking.account, { id: clearing })).toMatchObject({ iban: null, archived: true });
    await s.t.run((ctx) => ctx.db.delete(clearing));
    expect(await s.owner.query(api.banking.account, { id: clearing })).toBeNull();

    const e = await s.owner
      .mutation(api.banking.createAccount, { values: { name: "", currency: "EUR" } })
      .catch((x) => x);
    expect(errorCode(e)).toBe("invalid_input");
    expect((e as { data?: { field?: string } }).data?.field).not.toBeUndefined();
  });

  test("BNK-120 transaction list: date range, status, direction and full-text filters narrow the booked rows", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const all = await rows(s.t, s.eur);
    const list = async (args: Record<string, string>) =>
      (await s.owner.query(api.banking.transactions, { paginationOpts: PAGE, accountId: s.eur, ...args })).page;
    const ids = (xs: { _id: Id<"bankTransactions"> }[]) => xs.map((x) => x._id).sort();
    const expectIds = (xs: Doc<"bankTransactions">[]) => xs.map((x) => x._id).sort();

    expect(await list({})).toHaveLength(all.length);
    expect(ids(await list({ status: "all" }))).toEqual(expectIds(all));
    expect(ids(await list({ from: "2026-10-10", to: "2026-10-20" }))).toEqual(
      expectIds(all.filter((r) => r.bookingDate >= "2026-10-10" && r.bookingDate <= "2026-10-20")),
    );
    expect(ids(await list({ from: "2026-10-15" }))).toEqual(
      expectIds(all.filter((r) => r.bookingDate >= "2026-10-15")),
    );
    expect(ids(await list({ to: "2026-10-05" }))).toEqual(expectIds(all.filter((r) => r.bookingDate <= "2026-10-05")));
    expect(ids(await list({ direction: "in" }))).toEqual(expectIds(all.filter((r) => r.amountCents >= 0)));
    expect(ids(await list({ direction: "out" }))).toEqual(expectIds(all.filter((r) => r.amountCents < 0)));
    // free text over counterparty, purpose, reference and IBAN, case-insensitive
    const beta = await list({ q: "  BETA ag " });
    expect(beta).toHaveLength(2);
    expect(beta.every((r) => r.counterpartyName === "Beta AG")).toBe(true);
    expect(await list({ q: "de44500105175407324931" })).toHaveLength(1);
    expect(await list({ q: "kein Treffer xyz" })).toHaveLength(0);

    // status: „matched“ groups matched/partially/booked; a marked row is found by its own status
    const priv = byRef(all, "09");
    await s.owner.action(api.banking.mark, { transactionId: priv._id, as: "private" });
    expect(ids(await list({ status: "private" }))).toEqual([priv._id]);
    expect(await list({ status: "matched" })).toHaveLength(0);
    expect((await list({ status: "open" })).some((r) => r._id === priv._id)).toBe(false);
  });

  test("BNK-120 detail sheet: null for an unknown id; an open Finanzamt row suggests a tax payment (BNK-064), a marked row shows none", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    expect(await s.owner.query(api.banking.transaction, { id: await goneTransaction(s) })).toBeNull();
    const fa = await s.t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankTransactions",
        {
          accountId: s.eur,
          bookingDate: "2026-10-10",
          valueDate: "2026-10-11",
          amountCents: -123_400,
          currency: "EUR",
          counterpartyName: "Finanzamt Berlin",
          counterpartySource: "statement" as const,
          counterpartyBic: "MARKDEF1100",
          purpose: "USt-VA 09/2026 StNr 12/345/67890",
          reference: "UStVA 2026-09",
          mandateRef: "M-1",
          creditorId: "DE98ZZZ09999999999",
          endToEndId: "E2E-FA",
          source: {
            kind: "camt053" as const,
            providerTransactionId: "PTX-FA",
            proprietaryCode: "PMNT-ICDT-ESCT",
            bankTransactionCode: "PMNT-ICDT-ESCT",
            merchantName: "Finanzamt",
            bookedAtRaw: "2026-10-10T08:00:00Z",
            rawSha256: "fa",
          },
          sources: [{ kind: "revolut_csv" as const, providerTransactionId: "CSV-FA", rawSha256: "fa2", at: 1 }],
          dedupeKey: `${s.eur}:fa`,
          contentHash: "fa",
          status: "open" as const,
          allocatedCents: 0,
          recordedAt: Date.now(),
        },
        { action: "bank.import" },
      ),
    );
    const d = await s.owner.query(api.banking.transaction, { id: fa });
    expect(d).toMatchObject({
      valueDate: "2026-10-11",
      reference: "UStVA 2026-09",
      endToEndId: "E2E-FA",
      mandateRef: "M-1",
      creditorId: "DE98ZZZ09999999999",
      counterpartyBic: "MARKDEF1100",
      bankTransactionCode: "PMNT-ICDT-ESCT",
      proprietaryCode: "PMNT-ICDT-ESCT",
      merchantName: "Finanzamt",
      bookedAtRaw: "2026-10-10T08:00:00Z",
      exchangeRate: null,
      link: null,
      original: null,
      sourceKinds: ["camt053", "revolut_csv"],
    });
    expect(d?.sources.map((x) => x.reference)).toEqual(["PTX-FA", "CSV-FA"]);
    expect(d?.taxPayment).not.toBeNull();

    // a marked (private) row: no tax-payment suggestion, the posting is listed
    const priv = byRef(await rows(s.t, s.eur), "09");
    await s.owner.action(api.banking.mark, { transactionId: priv._id, as: "private" });
    const m = await s.owner.query(api.banking.transaction, { id: priv._id });
    expect(m?.taxPayment).toBeNull();
    expect(m?.postings).toHaveLength(1);
  });

  test("BNK-121 BNK-063 detail of a linked reversal shows the original and the neutralised peer, without candidates", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const list = await rows(s.t, s.eur);
    const original = byRef(list, "10");
    const counter = byRef(list, "11");
    await s.owner.mutation(api.banking.linkReversalTo, { counterId: counter._id, originalId: original._id });
    const d = await s.owner.query(api.banking.transaction, { id: counter._id });
    expect(d?.original).toEqual({
      id: original._id,
      bookingDate: original.bookingDate,
      amountCents: original.amountCents,
      purpose: original.purpose,
    });
    expect(d?.link).toEqual({ id: original._id, bookingDate: original.bookingDate, amountCents: original.amountCents });
    expect(d?.reversalCandidates).toEqual([]);
    expect(d?.reversalOfId).toBe(original._id);
  });
});

describe("F07 statement import guards (BNK-030…036, GOBD-20)", () => {
  test("BNK-033 an unknown storage id, an unreadable file and a non-PDF statement are refused before anything is stored", async () => {
    const s = await setup();
    const gone = await store(s.t, "x", "text/plain");
    await s.t.run((ctx) => ctx.storage.delete(gone));
    const missing = await s.owner
      .action(api.banking.previewImport, { accountId: s.eur, storageId: gone, fileName: "x.xml" })
      .catch((x) => x);
    expect(errorCode(missing)).toBe("not_found");
    expect(messageOf(missing)).toBe("Die hochgeladene Datei wurde nicht gefunden.");

    const binary = await s.t.run((ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([0xff, 0xfe, 0x00, 0xd8, 0x00, 0xdc, 0xff])])),
    );
    const unreadable = await s.owner
      .action(api.banking.previewImport, { accountId: s.eur, storageId: binary, fileName: "x.bin" })
      .catch(reasonOf);
    expect(["STATEMENT_UNREADABLE"]).toContain(unreadable);

    const camt = await store(s.t, camtOct, "application/xml");
    const notPdf = await store(s.t, "<html>kein PDF</html>", "text/html");
    const e = await s.owner
      .action(api.banking.commitImport, {
        accountId: s.eur,
        storageId: camt,
        fileName: "eur.camt053.xml",
        pdfStorageId: notPdf,
      })
      .catch((x) => x);
    expect(reasonOf(e)).toBe("PDF_REQUIRED");
    expect(messageOf(e)).toBe("Der Kontoauszug muss eine PDF-Datei sein.");
    const missingPdf = await s.owner
      .action(api.banking.commitImport, { accountId: s.eur, storageId: camt, fileName: "e.xml", pdfStorageId: gone })
      .catch(errorCode);
    expect(missingPdf).toBe("not_found");
    expect(await rows(s.t, s.eur)).toHaveLength(0);
  });

  test("BNK-033 a file larger than 10 MB is refused", async () => {
    const s = await setup();
    const big = await s.t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)])));
    const e = await s.owner
      .action(api.banking.previewImport, { accountId: s.eur, storageId: big, fileName: "big.xml" })
      .catch((x) => x);
    expect(errorCode(e)).toBe("invalid_input");
    expect(messageOf(e)).toBe("Die Datei ist größer als 10 MB.");
  });

  test("GOBD-20 the parsed content must be the stored file: a changed hash is a conflict; an unknown or archived account is not found", async () => {
    const s = await setup();
    const storageId = await store(s.t, camtOct, "application/xml");
    const e = await s.t
      .mutation(internal.banking.commitImportInternal, {
        actorContext: OWNER,
        accountId: s.eur,
        content: camtOct,
        contentSha256: "0".repeat(64),
        storageId,
        fileName: "eur.xml",
      })
      .catch((x) => x);
    expect(errorCode(e)).toBe("conflict");
    expect(messageOf(e)).toBe("Die Datei wurde während des Imports verändert.");

    await s.t.model(OWNER, (ctx) =>
      auditedPatch(ctx, "bankAccounts", s.usd, { archivedAt: Date.now() }, { action: "settings.bank_account.update" }),
    );
    const archived = await s.owner
      .query(api.banking.importPlan, { accountId: s.usd, content: usdOct, fileName: "usd.xml", fileSha256: "x" })
      .catch((x) => x);
    expect(errorCode(archived)).toBe("not_found");
    expect(messageOf(archived)).toBe("Das Bankkonto existiert nicht.");
    const unreadable = await s.owner
      .query(api.banking.importPlan, {
        accountId: s.eur,
        content: "kein Kontoauszug",
        fileName: "x.txt",
        fileSha256: "x",
      })
      .catch(reasonOf);
    expect(unreadable).toBe("STATEMENT_UNREADABLE");
  });

  test("BNK-030 EC-BNK-52 the archive lists files with and without PDF; a PDF is attached once and an unknown statement is not found", async () => {
    const s = await setup();
    const withPdf = await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml", true);
    const csv = await importFile(s, s.eur, csvOct, "eur-2026-10.csv");
    const list = await s.owner.query(api.banking.statements, { accountId: s.eur });
    expect(list).toHaveLength(2);
    const camt = list.find((x) => x.id === withPdf.statementId);
    expect(camt?.hasPdf).toBe(true);
    expect(camt?.files.map((f) => f.kind).sort()).toEqual(["data", "pdf"]);
    const other = list.find((x) => x.id === csv.statementId);
    expect(other).toMatchObject({ hasPdf: false, format: "revolut_csv", rolledBack: false });
    expect(other?.files.map((f) => f.kind)).toEqual(["data"]);

    const imports = await s.owner.query(api.banking.imports, { accountId: s.eur });
    expect(imports.map((i) => i.fileName).sort()).toEqual(["eur-2026-10.camt053.xml", "eur-2026-10.csv"]);
    expect(imports.every((i) => i.rolledBackAt === null)).toBe(true);

    const pdf = await store(s.t, "%PDF-1.7 statement", "application/pdf");
    const again = await s.owner
      .action(api.banking.attachStatementPdf, {
        statementId: withPdf.statementId as Id<"bankStatements">,
        storageId: pdf,
        name: "x.pdf",
      })
      .catch((x) => x);
    expect(reasonOf(again)).toBe("PDF_ALREADY_ATTACHED");
    expect(messageOf(again)).toBe("Für diesen Kontoauszug ist bereits ein PDF archiviert.");
    await s.owner.action(api.banking.attachStatementPdf, {
      statementId: csv.statementId as Id<"bankStatements">,
      storageId: pdf,
      name: "csv.pdf",
    });
    expect((await s.owner.query(api.banking.statements, { accountId: s.eur })).every((x) => x.hasPdf)).toBe(true);

    const goneSt = csv.statementId as Id<"bankStatements">;
    const snapshot = await s.t.run((ctx) => ctx.db.get(goneSt));
    await s.t.run((ctx) => ctx.db.delete(goneSt));
    const missing = await s.t
      .mutation(internal.banking.attachStatementPdfInternal, {
        actorContext: OWNER,
        statementId: goneSt,
        storageId: pdf,
        name: "y.pdf",
      })
      .catch(errorCode);
    expect(missing).toBe("not_found");
    expect(snapshot).not.toBeNull();
  });

  test("BNK-032 BNK-035 a Revolut CSV without the balance column imports with the period from its rows and no balances", async () => {
    const s = await setup();
    const csv = [
      "Date started (UTC),Date completed (UTC),ID,Type,Description,Reference,Payer,Card number,Orig currency,Orig amount,Payment currency,Amount,Fee,Account",
      "2026-10-03 09:11:00,2026-10-03 09:12:00,c0ffee00-0001-4c3b-9d10-000000000001,FEE,Basic plan fee,,,,EUR,-10.00,EUR,-10.00,0.00,EUR Main",
      "2026-10-07 10:04:00,2026-10-07 10:05:00,c0ffee00-0002-4c3b-9d10-000000000002,TRANSFER,Mueller GmbH,RE-2026-0042,Mueller GmbH,,EUR,1190.00,EUR,1190.00,0.00,EUR Main",
    ].join("\n");
    const storageId = await store(s.t, csv, "text/csv");
    const preview = await s.owner.action(api.banking.previewImport, {
      accountId: s.eur,
      storageId,
      fileName: "ohne-saldo.csv",
    });
    expect(preview.counts).toMatchObject({ total: 2, new: 2 });
    expect(preview.openingBalanceCents).toBeUndefined();
    expect(preview.closingBalanceCents).toBeUndefined();
    const r = await importFile(s, s.eur, csv, "ohne-saldo.csv");
    expect(r.counts).toMatchObject({ new: 2 });
    const [st] = await s.owner.query(api.banking.statements, { accountId: s.eur });
    expect(st).toMatchObject({ openingBalanceCents: null, closingBalanceCents: null, format: "revolut_csv" });
    expect((st?.periodFrom ?? "") <= "2026-10-03" && (st?.periodTo ?? "") >= "2026-10-07").toBe(true);
    const [imp] = await s.owner.query(api.banking.imports, { accountId: s.eur });
    expect(imp).toMatchObject({ fileName: "ohne-saldo.csv", periodFrom: st?.periodFrom, periodTo: st?.periodTo });
  });

  test("BNK-036 rollback: an unknown import is not found, a short reason and a second rollback are refused", async () => {
    const s = await setup();
    const r = await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const short = await s.owner
      .mutation(api.banking.rollback, { importId: r.importId, reason: "kurz" })
      .catch(messageOf);
    expect(short).toBe("Bitte einen Grund angeben (mindestens 5 Zeichen).");
    expect(await s.owner.mutation(api.banking.rollback, { importId: r.importId, reason: "falsches Konto" })).toEqual({
      rows: 13,
    });
    const twice = await s.owner
      .mutation(api.banking.rollback, { importId: r.importId, reason: "falsches Konto" })
      .catch((x) => x);
    expect(errorCode(twice)).toBe("conflict");
    expect(messageOf(twice)).toBe("Der Import wurde bereits zurückgenommen.");
    const imports = await s.owner.query(api.banking.imports, { accountId: s.eur });
    expect(imports[0]?.rolledBackAt).not.toBeNull();

    // a rolled-back row cannot be reopened
    const row = byRef(await rows(s.t, s.eur), "08");
    const reopen = await s.owner
      .mutation(api.banking.unmark, { transactionId: row._id, reason: "doch richtig" })
      .catch(messageOf);
    expect(reopen).toBe("Zurückgenommene Importe können nicht wieder geöffnet werden.");

    const gone = await s.t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankImports",
        {
          accountId: s.eur,
          source: "camt053",
          periodFrom: "2026-10-01",
          periodTo: "2026-10-31",
          counts: {
            total: 0,
            inserted: 0,
            duplicates: 0,
            mergedCrossSource: 0,
            possibleDuplicates: 0,
            conflicts: 0,
            rejected: 0,
          },
          at: Date.now(),
          actor: OWNER.actor,
        } as never,
        { action: "bank.import" },
      ),
    );
    await s.t.run((ctx) => ctx.db.delete(gone));
    expect(
      await s.owner.mutation(api.banking.rollback, { importId: gone, reason: "falsches Konto" }).catch(errorCode),
    ).toBe("not_found");
  });
});

describe("F07 possible duplicates (BNK-034/110, RI-29)", () => {
  async function withDuplicate() {
    const s = await setup();
    const existing = await s.t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankTransactions",
        {
          accountId: s.eur,
          bookingDate: "2026-10-05",
          amountCents: -380,
          currency: "EUR",
          counterpartyName: "Cafe Einstein",
          counterpartySource: "statement" as const,
          purpose: "Kaffee",
          source: { kind: "camt053" as const, entryReference: "ER-X", rawSha256: "x" },
          sources: [],
          dedupeKey: `${s.eur}:er:ER-X`,
          contentHash: "x",
          status: "open" as const,
          allocatedCents: 0,
          recordedAt: Date.now(),
        },
        { action: "bank.import" },
      ),
    );
    const dup = await s.t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "possibleDuplicates",
        {
          accountId: s.eur,
          candidate: {
            bookingDate: "2026-10-05",
            amountCents: -380,
            currency: "EUR",
            purpose: "Kaffee",
            kind: "revolut_csv",
            line: 4,
            dedupeKey: `${s.eur}:h:abc`,
            rawSha256: "y",
            raw: "{}",
            providerTransactionId: "CSV-1",
          },
          existingIds: [existing],
          reason: "same_amount_date_counterparty",
          status: "open",
          createdAt: Date.now(),
        } as never,
        { action: "bank.import" },
      ),
    );
    return { s, existing, dup };
  }

  test("BNK-034 the review lists open duplicates across accounts (no counterparty → null); a resolved one is refused, an unknown one not found", async () => {
    const { s, existing, dup } = await withDuplicate();
    const all = await s.owner.query(api.banking.possibleDuplicates, {});
    expect(all).toHaveLength(1);
    expect(all[0]?.candidate).toMatchObject({ counterpartyName: null, source: "revolut_csv", line: 4 });
    expect(all[0]?.existing).toEqual([
      {
        id: existing,
        bookingDate: "2026-10-05",
        amountCents: -380,
        purpose: "Kaffee",
        counterpartyName: "Cafe Einstein",
        sourceKinds: ["camt053"],
      },
    ]);
    expect(await s.owner.mutation(api.banking.resolveDuplicate, { id: dup, decision: "same" })).toBe(existing);
    const tx = await s.t.run((ctx) => ctx.db.get(existing));
    expect(tx?.sources).toMatchObject([{ kind: "revolut_csv", providerTransactionId: "CSV-1", rawSha256: "y" }]);
    expect(await s.owner.query(api.banking.possibleDuplicates, {})).toHaveLength(0);
    const again = await s.owner
      .mutation(api.banking.resolveDuplicate, { id: dup, decision: "separate" })
      .catch((x) => x);
    expect(errorCode(again)).toBe("conflict");
    expect(messageOf(again)).toBe("Diese Dublette wurde bereits geprüft.");
    await s.t.run((ctx) => ctx.db.delete(dup));
    expect(await s.owner.mutation(api.banking.resolveDuplicate, { id: dup, decision: "same" }).catch(errorCode)).toBe(
      "not_found",
    );
  });
});

describe("F07 marking guards (BNK-028, BNK-060…063, CSH-024)", () => {
  test("BNK-063 „Ignorieren“ needs no Eigenbeleg (markContext null); an unknown link or transaction is not found", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const list = await rows(s.t, s.eur);
    const fee = byRef(list, "01");
    expect(
      await s.owner.query(api.banking.markContext, {
        transactionId: fee._id,
        as: "ignored",
        reason: "test_or_zero",
      }),
    ).toBeNull();
    const gone = await goneTransaction(s);
    const noLink = await s.owner
      .query(api.banking.markContext, { transactionId: fee._id, as: "private", linkId: gone })
      .catch((x) => x);
    expect(errorCode(noLink)).toBe("not_found");
    expect(messageOf(noLink)).toBe("Der Bankumsatz existiert nicht.");
    expect(await s.owner.query(api.banking.markContext, { transactionId: gone, as: "private" }).catch(errorCode)).toBe(
      "not_found",
    );
    const link = await s.owner
      .mutation(api.banking.linkReversalTo, { counterId: gone, originalId: fee._id })
      .catch(errorCode);
    expect(link).toBe("not_found");
  });

  test("BNK-060 the Eigenbeleg data carries the company address, counterparty, purpose and reference", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const priv = byRef(await rows(s.t, s.eur), "09");
    const input = await s.owner.query(api.banking.markContext, { transactionId: priv._id, as: "private" });
    expect(input).toMatchObject({
      kind: expect.any(String),
      date: priv.bookingDate,
      amountCents: -100_000,
      currency: "EUR",
      company: { name: "Muster Consulting e.K.", address: "Hauptstr. 1, 10115 Berlin" },
      account: `Revolut EUR (${IBAN})`,
      counterpartyName: "Max Muster",
      purpose: "Privatentnahme",
      reference: priv.source.entryReference,
    });
    expect(input).not.toHaveProperty("loan");
  });

  test("BNK-028 a non-EUR row marked „Privat“ is deferred; as Geldtransit it needs the EUR side first", async () => {
    const s = await setup();
    await importFile(s, s.usd, usdOct, "usd-2026-10.camt053.xml");
    const usdRows = await rows(s.t, s.usd);
    const plain = usdRows.find((r) => !r.source.feeCents) as Doc<"bankTransactions">;
    const priv = await s.owner
      .query(api.banking.markContext, { transactionId: plain._id, as: "private" })
      .catch((x) => x);
    expect(reasonOf(priv)).toBe("FX_POSTING_DEFERRED");
    expect(messageOf(priv)).toBe(
      "Umsätze in Fremdwährung können erst mit der EUR-Bewertung (Kurs der EZB) gebucht werden. Bitte vorerst offen lassen.",
    );
    const transit = await s.owner
      .query(api.banking.markContext, { transactionId: plain._id, as: "transfer" })
      .catch((x) => x);
    expect(reasonOf(transit)).toBe("FX_PEER_REQUIRED");
    // „Ignorieren“ is not a posting: allowed on the foreign pocket
    expect(
      await s.owner.query(api.banking.markContext, { transactionId: plain._id, as: "ignored", reason: "test_or_zero" }),
    ).toBeNull();
  });

  test("CSH-024 a cash deposit can only be paired with a Geldtransit mark of a fitting credit", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const list = await rows(s.t, s.eur);
    const credit = list.find((r) => r.amountCents > 0) as Doc<"bankTransactions">;
    const cashId = await s.t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "cashTransfers",
        {
          date: credit.bookingDate,
          kind: "deposit_to_bank",
          amountCents: 1,
          bankAccountId: s.eur,
          journalEntryIds: [],
          recordedAt: Date.now(),
          actor: OWNER.actor,
        },
        { action: "cash.transfer" },
      ),
    );
    const wrongMark = await s.owner
      .query(api.banking.markContext, { transactionId: credit._id, as: "private", cashTransferId: cashId })
      .catch((x) => x);
    expect(reasonOf(wrongMark)).toBe("DEPOSIT_PAIR_REJECTED");
    expect(messageOf(wrongMark)).toBe("Diese Bareinzahlung ist bereits zugeordnet oder gehört zu einem anderen Konto.");
    const wrongAmount = await s.owner
      .query(api.banking.markContext, { transactionId: credit._id, as: "transfer", cashTransferId: cashId })
      .catch(reasonOf);
    expect(wrongAmount).toBe("DEPOSIT_PAIR_REJECTED");
  });

  test("BNK-062 a loan repayment split must add up; chart defaults and custom accounts are used", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const rent = byRef(await rows(s.t, s.eur), "08");
    const bad = await s.owner
      .query(api.banking.markContext, {
        transactionId: rent._id,
        as: "loan",
        loan: { principalCents: 1, interestCents: 1 },
      })
      .catch(reasonOf);
    expect(bad).toBe("LOAN_SPLIT_INVALID");
    const input = await s.owner.query(api.banking.markContext, {
      transactionId: rent._id,
      as: "loan",
      loan: { principalCents: 80_000, interestCents: 5_000, loanAccount: " 0630 ", interestAccount: "" },
    });
    expect(input?.loan).toEqual({ principalCents: 80_000, interestCents: 5_000 });
    await s.owner.action(api.banking.mark, {
      transactionId: rent._id,
      as: "loan",
      loan: { principalCents: 80_000, interestCents: 5_000, loanAccount: " 0630 ", interestAccount: "" },
    });
    const d = await s.owner.query(api.banking.transaction, { id: rent._id });
    expect(d?.status).toBe("booked");
    expect(d?.postings[0]?.lines.map((l) => l.account)).toEqual(expect.arrayContaining(["0630", "2100"]));
  });
});

describe("F07 unmarking (ACC-004, BNK-063)", () => {
  test("BNK-063 unmark needs a reason and a marked row; unmarking a neutralised pair reopens both halves", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const list = await rows(s.t, s.eur);
    const rent = byRef(list, "08");
    expect(
      await s.owner.mutation(api.banking.unmark, { transactionId: rent._id, reason: "abc" }).catch(messageOf),
    ).toBe("Bitte einen Grund angeben (mindestens 5 Zeichen).");
    expect(
      await s.owner.mutation(api.banking.unmark, { transactionId: rent._id, reason: "versehentlich" }).catch(messageOf),
    ).toBe("Der Umsatz ist nicht markiert.");

    const original = byRef(list, "10");
    const counter = byRef(list, "11");
    await s.owner.mutation(api.banking.linkReversalTo, { counterId: counter._id, originalId: original._id });
    await s.owner.mutation(api.banking.unmark, { transactionId: counter._id, reason: "keine Rückbuchung" });
    const after = await rows(s.t, s.eur);
    expect(byRef(after, "11")).toMatchObject({ status: "open" });
    expect(byRef(after, "11").ignoredLinkId).toBeUndefined();
    expect(byRef(after, "10")).toMatchObject({ status: "open" });

    // „Dublette aus Dateiimport“ needs another row with the same amount, never the row itself
    const cafe1 = byRef(list, "04");
    const cafe2 = byRef(list, "05");
    const self = await s.owner
      .action(api.banking.mark, {
        transactionId: cafe1._id,
        as: "ignored",
        reason: "duplicate_of_file_import",
        linkId: cafe1._id,
      })
      .catch(messageOf);
    expect(self).toMatch(/^Gebuchte Bankbewegungen müssen gebucht werden/);
    await s.owner.action(api.banking.mark, {
      transactionId: cafe1._id,
      as: "ignored",
      reason: "duplicate_of_file_import",
      linkId: cafe2._id,
    });
    expect(await s.t.run((ctx) => ctx.db.get(cafe1._id))).toMatchObject({
      status: "ignored",
      ignoredLinkId: cafe2._id,
    });
    // reopening it leaves the other row untouched
    await s.owner.mutation(api.banking.unmark, { transactionId: cafe1._id, reason: "doch keine Dublette" });
    expect((await s.t.run((ctx) => ctx.db.get(cafe1._id)))?.status).toBe("open");
    expect((await s.t.run((ctx) => ctx.db.get(cafe2._id)))?.status).toBe("open");
  });

  test("CSH-025 unmarking an ATM withdrawal reverses the cash leg; unmarking a Geldtransit pair side frees the other side", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const list = await rows(s.t, s.eur);
    const atm = byRef(list, "06");
    await s.owner.action(api.banking.mark, { transactionId: atm._id, as: "cash_withdrawal" });
    expect((await s.owner.query(api.cash.overview, {})).balanceCents).toBe(20_000);
    await s.owner.mutation(api.banking.unmark, { transactionId: atm._id, reason: "doch keine Abhebung" });
    const cash = await s.owner.query(api.cash.overview, {});
    expect(cash.balanceCents).toBe(0);
    expect(cash.transfers.map((x) => x.reversed || x.reversalOfId !== null)).toEqual([true, true]);
    expect((await s.t.run((ctx) => ctx.db.get(atm._id)))?.status).toBe("open");

    // Geldtransit pair between two EUR rows of the same day on two own accounts
    const other = await s.owner.mutation(api.banking.createAccount, {
      values: {
        name: "Sparkonto",
        currency: "EUR",
        iban: "DE89370400440532013000",
        bic: "",
        accountHolder: "Max Muster",
        showOnInvoices: false,
      },
    });
    const mk = (accountId: Id<"bankAccounts">, amountCents: number, key: string, iban: string) =>
      s.t.model(OWNER, (ctx) =>
        auditedInsert(
          ctx,
          "bankTransactions",
          {
            accountId,
            bookingDate: "2026-10-20",
            amountCents,
            currency: "EUR",
            counterpartyIban: iban,
            purpose: "Umbuchung",
            source: { kind: "camt053" as const, entryReference: key, rawSha256: key },
            sources: [],
            dedupeKey: `${accountId}:er:${key}`,
            contentHash: key,
            status: "open" as const,
            allocatedCents: 0,
            recordedAt: Date.now(),
          },
          { action: "bank.import" },
        ),
      );
    const out = await mk(s.eur, -50_000, "T-OUT", "DE89370400440532013000");
    const inn = await mk(other, 50_000, "T-IN", IBAN);
    await s.owner.action(api.banking.mark, { transactionId: out, as: "transfer" });
    await s.owner.action(api.banking.mark, { transactionId: inn, as: "transfer" });
    expect((await s.t.run((ctx) => ctx.db.get(out)))?.transferPeerId).toBe(inn);
    await s.owner.mutation(api.banking.unmark, { transactionId: inn, reason: "falsch zugeordnet" });
    const outAfter = await s.t.run((ctx) => ctx.db.get(out));
    expect(outAfter?.status).toBe("transfer");
    expect(outAfter?.transferPeerId).toBeUndefined();
  });
});

describe("F07 allocation hook and the matching extension point (BNK-122, RI-10)", () => {
  test("BNK-122 applyAllocation refuses unsafe amounts, non-allocatable rows and over-allocation; releases go back to open", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const list = await rows(s.t, s.eur);
    const credit = byRef(list, "02");
    const priv = byRef(list, "09");
    const alloc = (id: Id<"bankTransactions">, deltaCents: number) =>
      s.t.model(OWNER, (ctx) => applyAllocation(ctx, { transactionId: id, deltaCents }));
    await s.owner.action(api.banking.mark, { transactionId: priv._id, as: "private" });
    expect(await alloc(credit._id, 1_000)).toBe("partially_matched");
    expect(await alloc(credit._id, -1_000)).toBe("open");
    expect(await alloc(credit._id, 0.5).catch(messageOf)).toBe("Ungültiger Betrag.");
    expect(await alloc(credit._id, credit.amountCents + 1).catch(reasonOf)).toBe("ALLOCATION_EXCEEDS");
    expect(await alloc(priv._id, -100).catch(reasonOf)).toBe("TX_NOT_ALLOCATABLE");
  });

  test("RI-10 unmatched rows: all accounts or one account, with the limit, newest first", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    await importFile(s, s.usd, usdOct, "usd-2026-10.camt053.xml");
    const all = await s.t.run((ctx) => unmatchedTransactions(ctx, {}));
    expect(all.some((u) => u.accountId === s.usd)).toBe(true);
    expect(all.some((u) => u.accountId === s.eur)).toBe(true);
    const sorted = [...all].sort((x, y) => y.bookingDate.localeCompare(x.bookingDate));
    expect(all.map((u) => u.bookingDate)).toEqual(sorted.map((u) => u.bookingDate));
    const limited = await s.t.run((ctx) => unmatchedTransactions(ctx, { accountId: s.usd, limit: 1 }));
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({ accountId: s.usd, accountName: "Revolut USD", currency: "USD" });
    const cafe = all.find((u) => u.counterpartyName === "Adobe Systems");
    expect(cafe?.instructedAmount).toBeDefined();
    expect(cafe?.direction).toBe("out");
  });
});
