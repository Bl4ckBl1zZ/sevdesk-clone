/// <reference types="vite/client" />
import { describe, expect, test, vi } from "vitest";
import camtOct from "../test/fixtures/bank/revolut-statements/synthetic-2026-10/eur-2026-10.camt053.xml?raw";
import csvOct from "../test/fixtures/bank/revolut-statements/synthetic-2026-10/eur-2026-10.csv?raw";
import mt940Oct from "../test/fixtures/bank/revolut-statements/synthetic-2026-10/eur-2026-10.mt940.txt?raw";
import overlap from "../test/fixtures/bank/revolut-statements/synthetic-2026-10/eur-2026-10-23_2026-11-05.overlap.camt053.xml?raw";
import gapNov from "../test/fixtures/bank/revolut-statements/synthetic-2026-10/eur-2026-11-10_2026-11-30.gap.camt053.xml?raw";
import usdOct from "../test/fixtures/bank/revolut-statements/synthetic-2026-10/usd-2026-10.camt053.xml?raw";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import { patchCompanyProfile } from "./model/companyProfile";
import { fileReferences } from "./model/files";
import { makeT, type TestT } from "./test.setup";

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

const store = (t: TestT, content: string, type: string) =>
  t.run((ctx) => ctx.storage.store(new Blob([content], { type })));

async function importFile(
  s: Awaited<ReturnType<typeof setup>>,
  accountId: Id<"bankAccounts">,
  content: string,
  fileName: string,
  opts: { pdf?: boolean; force?: boolean } = {},
) {
  const storageId = await store(s.t, content, "application/octet-stream");
  const preview = await s.owner.action(api.banking.previewImport, { accountId, storageId, fileName });
  const pdfStorageId = opts.pdf ? await store(s.t, "%PDF-1.7 signed statement", "application/pdf") : undefined;
  const result = await s.owner.action(api.banking.commitImport, {
    accountId,
    storageId,
    fileName,
    ...(pdfStorageId ? { pdfStorageId, pdfName: "Kontoauszug-2026-10.pdf" } : {}),
    ...(opts.force ? { force: true } : {}),
  });
  return { preview, result, storageId };
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

describe("F07 statement import pipeline (BNK-030…036)", () => {
  test("T07-041 EC-156 BNK-030 CAMT.053 import: preview counts, commit, reconciled with the closing balance", async () => {
    const s = await setup();
    const { preview, result } = await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml", { pdf: true });
    expect(preview.counts).toMatchObject({ total: 13, new: 13, duplicates: 0, conflicts: 0 });
    expect(preview.arithmetic.status).toBe("ok");
    expect(preview.continuity.status).toBe("first");
    expect(result.counts.new).toBe(13);
    expect(result.reconciled).toBe(true);
    const statements = await s.owner.query(api.banking.statements, { accountId: s.eur });
    expect(statements[0]).toMatchObject({
      reconciled: true,
      closingBalanceCents: 1_300_723,
      expectedClosingCents: 1_300_723,
      diffCents: 0,
    });
    expect((await rows(s.t, s.eur)).length).toBe(13);
  });

  test("T07-041 EC-BNK-41 a statement missing one transaction → not reconciled with a difference list", async () => {
    const s = await setup();
    // Drop the Hetzner entry but keep the balances: Σ ≠ closing.
    const withoutLast = camtOct.replace(/<Ntry>(?:(?!<Ntry>)[\s\S])*?Hetzner[\s\S]*?<\/Ntry>/, "");
    const { result } = await importFile(s, s.eur, withoutLast, "kaputt.xml");
    expect(result.reconciled).toBe(false);
    expect(result.message).toMatch(/^Kontoauszug Oktober 2026 stimmt nicht mit den Umsätzen überein: Differenz/);
  });

  test("T07-043 EC-BNK-42 GOBD-20 same statement twice → rejected by hash; retention vouchers8; signed PDF with sha256", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml", { pdf: true });
    const [st] = await s.owner.query(api.banking.statements, { accountId: s.eur });
    expect(st?.retentionUntil).toBe("2034-12-31");
    expect(st?.hasPdf).toBe(true);
    expect(st?.files.find((f) => f.kind === "pdf")?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The archived files can never be deleted through the file cleanup (GOBD-20).
    const pdfId = await s.t.run(async (ctx) => (await ctx.db.query("bankStatements").first())?.pdf?.storageId);
    expect(await s.t.run((ctx) => fileReferences(ctx, pdfId as Id<"_storage">))).toHaveLength(1);
    const again = await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml").catch((e) => e);
    expect(errorCode(again)).toBe("conflict");
    expect(messageOf(again)).toMatch(/^Dieser Kontoauszug wurde bereits hochgeladen \(\d\d\.\d\d\.\d{4}\)\.$/);
  });

  test("T07-049 EC-BNK-45 same file forced → preview warns, 0 inserted, no second archive entry", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const { preview, result } = await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml", { force: true });
    expect(preview.alreadyImported?.message).toMatch(/^Diese Datei wurde bereits importiert/);
    expect(result.counts).toMatchObject({ new: 0, duplicates: 13 });
    expect(result.statementId).toBeNull();
    expect((await rows(s.t, s.eur)).length).toBe(13);
    expect((await s.owner.query(api.banking.statements, { accountId: s.eur })).length).toBe(1);
  });

  test("T07-045 T07-142 EC-148 BNK-110 Revolut CSV then CAMT.053 of the same month → 0 new rows, sources appended, reconciled", async () => {
    const s = await setup();
    const csv = await importFile(s, s.eur, csvOct, "eur-2026-10.csv");
    expect(csv.result.counts.new).toBe(13);
    const camt = await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    expect(camt.preview.counts).toMatchObject({ new: 0, merged: 13, conflicts: 0, possibleDuplicates: 0 });
    expect(camt.result.reconciled).toBe(true);
    const list = await rows(s.t, s.eur);
    expect(list.length).toBe(13);
    expect(list.every((r) => r.sources.some((x) => x.kind === "camt053"))).toBe(true);
  });

  test("T07-151 BNK-110 CAMT.053 first, then the Revolut CSV of the same month → 0 new, both statements reconciled", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const csv = await importFile(s, s.eur, csvOct, "eur-2026-10.csv");
    expect(csv.preview.counts).toMatchObject({ new: 0, merged: 13, conflicts: 0, possibleDuplicates: 0 });
    expect(csv.result.reconciled).toBe(true);
    const statements = await s.owner.query(api.banking.statements, { accountId: s.eur });
    expect(statements.map((x) => x.reconciled)).toEqual([true, true]);
  });

  test("T07-050 EC-BNK-47 BNK-035 statement after a missing period → „Saldenlücke“; overlap → no duplicates", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const ov = await importFile(s, s.eur, overlap, "overlap.xml");
    expect(ov.preview.counts.new).toBeGreaterThan(0);
    expect(ov.preview.counts.new + ov.preview.counts.duplicates).toBe(ov.preview.counts.total);
    const gap = await importFile(s, s.eur, gapNov, "gap.xml");
    expect(gap.preview.continuity.status).toBe("gap");
    expect("message" in gap.preview.continuity ? gap.preview.continuity.message : "").toBe(
      "Anfangssaldo (13.349,98 €) passt nicht zum letzten Endsaldo (13.297,23 €) – fehlen Umsätze zwischen 05.11.2026 und 10.11.2026?",
    );
  });

  test("T07-054 EC-BNK-53 file of another account is blocked; EC-BNK-52 statement without PDF → to-do", async () => {
    const s = await setup();
    const storageId = await store(s.t, usdOct, "application/xml");
    const e = await s.owner
      .action(api.banking.previewImport, { accountId: s.eur, storageId, fileName: "usd.xml" })
      .catch((x) => x);
    expect(reasonOf(e)).toBe("STATEMENT_WRONG_ACCOUNT");
    expect(messageOf(e)).toBe(`Die Datei gehört zu Konto ${IBAN} (USD), nicht zu Revolut EUR (EUR).`);
    await importFile(s, s.usd, usdOct, "usd.xml");
    vi.useFakeTimers({ now: new Date("2026-11-04T09:00:00Z"), toFake: ["Date"] });
    try {
      const todos = await s.owner.query(api.banking.todos, {});
      expect(todos.find((t) => t.accountId === s.usd && t.month === "2026-10")).toMatchObject({
        kind: "pdf_missing",
        title: "Für Oktober 2026 fehlt der signierte PDF-Kontoauszug.",
      });
      // The EUR account has no October statement at all (EC-156 to-do).
      expect(todos.find((t) => t.accountId === s.eur && t.month === "2026-10")?.kind).toBe("statement_missing");
    } finally {
      vi.useRealTimers();
    }
  });

  test("T07-052 EC-BNK-50 BNK-036 rollback blocked once a row is marked; otherwise rows ignored and statement flagged", async () => {
    const s = await setup();
    const { result } = await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const fee = byRef(await rows(s.t, s.eur), "01");
    await s.owner.action(api.banking.mark, { transactionId: fee._id, as: "transfer" });
    const blocked = await s.owner
      .mutation(api.banking.rollback, { importId: result.importId, reason: "falsches Konto" })
      .catch(reasonOf);
    expect(blocked).toBe("ROLLBACK_BLOCKED");
    await s.owner.mutation(api.banking.unmark, { transactionId: fee._id, reason: "versehentlich markiert" });
    await s.owner.mutation(api.banking.rollback, { importId: result.importId, reason: "falsches Konto" });
    const list = await rows(s.t, s.eur);
    expect(list.every((r) => r.status === "ignored" && r.ignoredReason === "import_rolled_back")).toBe(true);
    expect((await s.owner.query(api.banking.statements, { accountId: s.eur }))[0]?.rolledBack).toBe(true);
  });
});

describe("F07 marking, reversals and cash (BNK-060/061/063/121, CSH-024…027)", () => {
  test("T07-090 BNK-060 private marking posts T1 (1800) with an archived Eigenbeleg; unmark reverses", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const priv = byRef(await rows(s.t, s.eur), "09");
    expect(await s.owner.action(api.banking.mark, { transactionId: priv._id, as: "private" })).toEqual({
      status: "private",
    });
    const detail = await s.owner.query(api.banking.transaction, { id: priv._id });
    expect(detail?.status).toBe("private");
    expect(detail?.postings[0]).toMatchObject({ explanation: "T1", date: "2026-10-15" });
    expect(detail?.postings[0]?.lines[0]).toMatchObject({ account: "1800", debitCents: 100_000 });
    expect(detail?.eigenbelege[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    await s.owner.mutation(api.banking.unmark, { transactionId: priv._id, reason: "doch Geschäftsausgabe" });
    const after = await s.owner.query(api.banking.transaction, { id: priv._id });
    expect(after?.status).toBe("open");
    expect(after?.postings.map((p) => p.reversal)).toEqual([false, true]);
  });

  test("T07-090 EC-BNK-21 a GmbH cannot mark „Privat“ without the shareholder clearing data", async () => {
    const s = await setup("gmbh");
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const priv = byRef(await rows(s.t, s.eur), "09");
    const e = await s.owner.action(api.banking.mark, { transactionId: priv._id, as: "private" }).catch((x) => x);
    expect(messageOf(e)).toBe(
      "Kapitalgesellschaften haben kein Privatkonto. Bitte ‚Verrechnungskonto Gesellschafter‘ verwenden.",
    );
    // With shareholder + note the entry goes to „Verrechnungskonto Gesellschafter“ (ACC-028), which the shipped SKR03
    // mapping leaves to the owner/advisor: unmapped → the whole mark is rolled back (atomic), nothing stays half done.
    const unmapped = await s.owner
      .action(api.banking.mark, {
        transactionId: priv._id,
        as: "private",
        shareholder: { name: "Max Muster", note: "Entnahme Oktober" },
      })
      .catch(errorCode);
    expect(unmapped).toBe("role_unmapped");
    const d = await s.owner.query(api.banking.transaction, { id: priv._id });
    expect(d).toMatchObject({ status: "open", postings: [], eigenbelege: [] });
  });

  test("T07-093 EC-BNK-67 ignoring needs an allowed reason; T07-027 BNK-121 a reversal neutralises its original", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const list = await rows(s.t, s.eur);
    const rent = byRef(list, "08");
    const noReason = await s.owner
      .action(api.banking.mark, { transactionId: rent._id, as: "ignored" })
      .catch(messageOf);
    expect(noReason).toMatch(/^Gebuchte Bankbewegungen müssen gebucht werden/);
    const original = byRef(list, "10");
    const counter = byRef(list, "11");
    expect(counter.reversal).toBe(true);
    const detail = await s.owner.query(api.banking.transaction, { id: counter._id });
    expect(detail?.reversalCandidates[0]?.originalId).toBe(original._id);
    await s.owner.mutation(api.banking.linkReversalTo, { counterId: counter._id, originalId: original._id });
    const after = await rows(s.t, s.eur);
    expect(byRef(after, "11")).toMatchObject({
      status: "ignored",
      ignoredReason: "neutralised_pair",
      reversalOfId: original._id,
    });
    expect(byRef(after, "10")).toMatchObject({ status: "ignored", ignoredReason: "neutralised_pair" });
    const unmatched = await s.owner.query(api.banking.unmatched, { accountId: s.eur });
    expect(unmatched.some((u) => u.id === original._id || u.id === counter._id)).toBe(false);
  });

  test("T07-095 CSH-025 ATM debit „Bargeld in die Kasse“ → cash inflow on the booking date via transit, fee as bank fee", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const atm = byRef(await rows(s.t, s.eur), "06");
    await s.owner.action(api.banking.mark, { transactionId: atm._id, as: "cash_withdrawal" });
    const cash = await s.owner.query(api.cash.overview, {});
    expect(cash.balanceCents).toBe(20_000);
    expect(cash.transfers[0]).toMatchObject({
      kind: "bank_withdrawal_to_cash",
      amountCents: 20_000,
      date: "2026-10-09",
      fromBank: true,
    });
    expect(cash.transfers[0]?.eigenbeleg?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const d = await s.owner.query(api.banking.transaction, { id: atm._id });
    expect(d?.status).toBe("transfer");
    expect(d?.postings[0]?.explanation).toBe("T9");
  });

  test("T07-108 T07-114 CSH-024 cash deposit with Eigenbeleg; CSH-026 never negative; CSH-027 reversal", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const atm = byRef(await rows(s.t, s.eur), "06");
    await s.owner.action(api.banking.mark, { transactionId: atm._id, as: "cash_withdrawal" });
    const tooMuch = await s.owner
      .action(api.cash.recordTransfer, {
        kind: "deposit_to_bank",
        date: "2026-10-10",
        amountCents: 30_000,
        bankAccountId: s.eur,
        backdateReason: "Nachtrag aus Belegen",
      })
      .catch(errorCode);
    expect(tooMuch).toBe("cash_negative");
    const ok = await s.owner.action(api.cash.recordTransfer, {
      kind: "deposit_to_bank",
      date: "2026-10-10",
      amountCents: 15_000,
      bankAccountId: s.eur,
      backdateReason: "Nachtrag aus Belegen",
    });
    const cash = await s.owner.query(api.cash.overview, {});
    expect(cash.balanceCents).toBe(5_000);
    expect(cash.transfers.find((t) => t.id === ok.id)?.eigenbeleg?.sha256).toMatch(/^[0-9a-f]{64}$/);
    await s.owner.mutation(api.cash.reverseTransfer, { id: ok.id, reason: "falscher Betrag" });
    expect((await s.owner.query(api.cash.overview, {})).balanceCents).toBe(20_000);
  });

  test("T07-148 EC-CSH-32 private cash withdrawal is blocked for a GmbH", async () => {
    const s = await setup("gmbh");
    const e = await s.owner
      .action(api.cash.recordTransfer, { kind: "private_withdrawal", date: "2026-10-13", amountCents: 1_000 })
      .catch(reasonOf);
    expect(e).toBe("PRIVATE_WITHDRAWAL_CORPORATION");
  });

  test("T07-068 RI-10 matching extension point: unmatched rows with open amount; allocation beyond the amount rejected", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    const unmatched = await s.owner.query(api.banking.unmatched, { accountId: s.eur });
    const mueller = unmatched.find((u) => u.counterpartyName === "Mueller GmbH");
    expect(mueller).toMatchObject({ openCents: 119_000, direction: "in", endToEndId: "E2E-MUELLER-0042" });
    const { applyAllocation } = await import("./model/bankTransactions");
    const id = mueller?.id as Id<"bankTransactions">;
    expect(await s.t.model(OWNER, (ctx) => applyAllocation(ctx, { transactionId: id, deltaCents: 19_000 }))).toBe(
      "partially_matched",
    );
    const over = await s.t
      .model(OWNER, (ctx) => applyAllocation(ctx, { transactionId: id, deltaCents: 100_001 }))
      .catch(reasonOf);
    expect(over).toBe("ALLOCATION_EXCEEDS");
    const again = await s.owner.query(api.banking.unmatched, { accountId: s.eur });
    expect(again.find((u) => u.id === id)?.openCents).toBe(100_000);
  });

  test("BNK-034 RI-29 possible duplicates: „getrennt“ inserts the second booking, „gleich“ only records the delivery", async () => {
    const s = await setup();
    await importFile(s, s.eur, camtOct, "eur-2026-10.camt053.xml");
    // A file without bank IDs (MT940-like hash keys) re-delivering the two identical coffees → review list.

    const r = await importFile(s, s.eur, mt940Oct, "eur-2026-10.mt940.txt");
    expect(r.preview.counts.possibleDuplicates).toBeGreaterThan(0);
    const dups = await s.owner.query(api.banking.possibleDuplicates, { accountId: s.eur });
    expect(dups.length).toBe(r.preview.counts.possibleDuplicates);
    const before = (await rows(s.t, s.eur)).length;
    await s.owner.mutation(api.banking.resolveDuplicate, {
      id: dups[0]?.id as Id<"possibleDuplicates">,
      decision: "same",
    });
    expect((await rows(s.t, s.eur)).length).toBe(before);
    await s.owner.mutation(api.banking.resolveDuplicate, {
      id: dups[1]?.id as Id<"possibleDuplicates">,
      decision: "separate",
    });
    expect((await rows(s.t, s.eur)).length).toBe(before + 1);
  });
});
