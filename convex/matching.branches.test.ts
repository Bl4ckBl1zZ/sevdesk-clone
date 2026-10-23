import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert, auditedPatch } from "./model/audit";
import {
  autoApplyMatches,
  confirmMatch,
  linkBankReversal,
  matchContext,
  rejectMatch,
  targetLabels,
} from "./model/matching";
import { categorizeByRule, ruleFor } from "./model/matchingRules";
import { bookedTransaction } from "./payments.fixtures";
import { makeT, type TestT } from "./test.setup";
import { line, setupCompany, TODAY, upload } from "./vouchers.fixtures";

/**
 * F07 matching (BNK-040…BNK-049, BNK-121, PAY-030/033/047) — guard paths, label fallbacks and the read-side context of
 * `convex/model/matching.ts` that the scenario tests in matching.test.ts do not reach.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message ?? String(e);
const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;
const docOf = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"salesDocuments">);
const txOf = (t: TestT, id: Id<"bankTransactions">) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"bankTransactions">);
const aliasesOf = (t: TestT, contactId: Id<"contacts">) =>
  t.run((ctx) =>
    ctx.db
      .query("contactAliases")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .collect(),
  );

async function setup() {
  const t = makeT();
  const f = await finalizedInvoice(t);
  const id = f.id as Id<"salesDocuments">;
  const d = await docOf(t, id);
  return { t, ...f, id, personId: f.personId as Id<"contacts">, name: d.contactName ?? "" };
}

let opN = 0;
const openingItem = (
  t: TestT,
  over: Partial<Pick<Doc<"openingItems">, "contactId" | "dueDate" | "openAmountCents" | "counterpartyName">> = {},
) =>
  t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "openingItems",
      {
        fiscalYear: 2026,
        kind: "receivable",
        number: `OP-${++opN}`,
        documentDate: "2025-12-15",
        counterpartyName: over.counterpartyName ?? "Altkunde Meier",
        grossCents: 50_000,
        openCents: 50_000,
        taxedAs: "soll",
        openAmountCents: over.openAmountCents ?? 50_000,
        recordedAt: Date.now(),
        actor: "user:test-owner",
        ...(over.contactId ? { contactId: over.contactId } : {}),
        ...(over.dueDate ? { dueDate: over.dueDate } : {}),
      },
      { action: "journal.opening_balance" },
    ),
  );

describe("BNK-046 confirm guards", () => {
  test("BNK-046 a confirmation without any allocation is refused", async () => {
    const { t, bankAccount } = await setup();
    const tx = await bookedTransaction(t, bankAccount, { bookingDate: "2026-10-12", amountCents: 5_000, purpose: "x" });
    const e = await t.model(OWNER, (ctx) => confirmMatch(ctx, { transactionId: tx, allocations: [] })).catch((x) => x);
    expect(errorCode(e)).toBe("invalid_input");
    expect(messageOf(e)).toBe("Bitte mindestens eine Zuordnung angeben.");
  });

  test("PAY-047 an existing manual payment is reconciled alone, never together with another target", async () => {
    const { t, bankAccount, id } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: "x",
    });
    const e = await t
      .model(OWNER, (ctx) =>
        confirmMatch(ctx, {
          transactionId: tx,
          allocations: [
            { target: { kind: "payment", id: "p1" }, amountCents: 60_000 },
            { target: { kind: "salesDocument", id }, amountCents: 59_000 },
          ],
        }),
      )
      .catch((x) => x);
    expect(messageOf(e)).toBe("Eine erfasste Zahlung wird allein abgeglichen.");
    expect((await txOf(t, tx)).allocatedCents).toBe(0);
  });

  test("BNK-049 an outgoing debit pays exactly one voucher", async () => {
    const { t, bankAccount } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: -2_000,
      purpose: "x",
    });
    const e = await t
      .model(OWNER, (ctx) =>
        confirmMatch(ctx, {
          transactionId: tx,
          allocations: [
            { target: { kind: "voucher", id: "v1" }, amountCents: 1_000 },
            { target: { kind: "voucher", id: "v2" }, amountCents: 1_000 },
          ],
        }),
      )
      .catch((x) => x);
    expect(messageOf(e)).toBe("Ein Bankumsatz wird hier genau einem Beleg zugeordnet.");
    expect(reasonOf(e)).toBe("TARGET_KIND");
  });

  test("EC-BNK-25 a write-off difference is not possible on a voucher payment (only bank fees, Skonto, other)", async () => {
    const { t, bankAccount } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: -2_000,
      purpose: "x",
    });
    const e = await t
      .model(OWNER, (ctx) =>
        confirmMatch(ctx, {
          transactionId: tx,
          allocations: [
            {
              target: { kind: "voucher", id: "v1" },
              amountCents: 2_000,
              differences: [{ reason: "write_off" as never, amountCents: 100 }],
            },
          ],
        }),
      )
      .catch((x) => x);
    expect(messageOf(e)).toBe("Diese Differenz ist bei Belegen nicht möglich.");
    expect(reasonOf(e)).toBe("DIFFERENCE_REASON");
  });

  test("PAY-033 an outgoing debit can only refund a credit balance or a credit correction", async () => {
    const { t, bankAccount } = await setup();
    const op = await openingItem(t);
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: -2_000,
      purpose: "x",
    });
    const e = await t
      .model(OWNER, (ctx) =>
        confirmMatch(ctx, {
          transactionId: tx,
          allocations: [{ target: { kind: "opening_item", id: op }, amountCents: 2_000 }],
        }),
      )
      .catch((x) => x);
    expect(messageOf(e)).toBe(
      "Ausgehende Umsätze können nur einem Kundenguthaben oder einer Rechnungskorrektur (Erstattung) zugeordnet werden.",
    );
    expect(reasonOf(e)).toBe("TX_DIRECTION");
  });

  test("BNK-046 an incoming transaction cannot be allocated to a voucher", async () => {
    const { t, bankAccount } = await setup();
    const tx = await bookedTransaction(t, bankAccount, { bookingDate: "2026-10-12", amountCents: 2_000, purpose: "x" });
    const e = await t
      .model(OWNER, (ctx) =>
        confirmMatch(ctx, {
          transactionId: tx,
          allocations: [{ target: { kind: "voucher", id: "v1" }, amountCents: 2_000 }],
        }),
      )
      .catch((x) => x);
    expect(messageOf(e)).toBe("Diese Zuordnung ist nicht möglich.");
    expect(reasonOf(e)).toBe("TARGET_KIND");
  });

  test("PAY-030 a remainder to the credit balance needs a customer (opening item without contact)", async () => {
    const { t, bankAccount } = await setup();
    const op = await openingItem(t);
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 60_000,
      purpose: "x",
    });
    const e = await t
      .model(OWNER, (ctx) =>
        confirmMatch(ctx, {
          transactionId: tx,
          allocations: [{ target: { kind: "opening_item", id: op }, amountCents: 50_000 }],
          remainder: "credit",
        }),
      )
      .catch((x) => x);
    expect(messageOf(e)).toBe("Für ein Guthaben fehlt der Kunde.");
    expect(reasonOf(e)).toBe("NO_CONTACT");
  });

  test("PAY-030 the remainder is added to an explicit credit allocation instead of a second one", async () => {
    const { t, owner, bankAccount, id, personId } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 130_000,
      purpose: "Zahlung",
    });
    await t.model(OWNER, (ctx) =>
      confirmMatch(ctx, {
        transactionId: tx,
        allocations: [
          { target: { kind: "contactCredit", id: personId }, amountCents: 1_000 },
          { target: { kind: "salesDocument", id }, amountCents: 119_000 },
        ],
        remainder: "credit",
        acknowledgeWarnings: [],
        provenance: { score: 0.8, reasons: ["exact_amount"], auto: false },
      }),
    );
    expect((await owner.query(api.payments.contactCredit, { contactId: personId })).balanceCents).toBe(11_000);
    expect((await docOf(t, id)).paymentStatus).toBe("paid");
    expect((await txOf(t, tx)).status).toBe("matched");
  });

  test("PAY-033 an opening item (F09 Altforderung) is settled through the bank match; its contact is learned", async () => {
    const { t, bankAccount, personId } = await setup();
    const op = await openingItem(t, { contactId: personId, dueDate: "2026-01-15" });
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 50_000,
      purpose: "Altforderung",
      counterpartyIban: "DE02120300000000202051",
    });
    await t.model(OWNER, (ctx) =>
      confirmMatch(ctx, {
        transactionId: tx,
        allocations: [{ target: { kind: "opening_item", id: op }, amountCents: 50_000 }],
      }),
    );
    expect((await t.run((ctx) => ctx.db.get(op)))?.openAmountCents).toBe(0);
    const [alias] = await aliasesOf(t, personId);
    expect(alias?.iban).toBe("DE02120300000000202051");
  });
});

describe("BNK-048 alias learning", () => {
  test("BNK-048 nothing is learned without counterparty name and IBAN", async () => {
    const { t, bankAccount, id, personId } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 10_000,
      purpose: "x",
    });
    await t.model(OWNER, (ctx) =>
      confirmMatch(ctx, {
        transactionId: tx,
        allocations: [{ target: { kind: "salesDocument", id }, amountCents: 10_000 }],
      }),
    );
    expect(await aliasesOf(t, personId)).toEqual([]);
  });

  test("BNK-048 the contact's own name without IBAN is no new alias; an IBAN without name gets the contact's token once", async () => {
    const { t, bankAccount, id, personId } = await setup();
    const contact = await t.run(async (ctx) => (await ctx.db.get(personId)) as Doc<"contacts">);
    const pay = async (over: { counterpartyName?: string; counterpartyIban?: string }) => {
      const tx = await bookedTransaction(t, bankAccount, {
        bookingDate: "2026-10-12",
        amountCents: 10_000,
        purpose: "x",
        ...over,
      });
      await t.model(OWNER, (ctx) =>
        confirmMatch(ctx, {
          transactionId: tx,
          allocations: [{ target: { kind: "salesDocument", id }, amountCents: 10_000 }],
        }),
      );
    };
    await pay({ counterpartyName: contact.displayName });
    expect(await aliasesOf(t, personId)).toEqual([]);
    await pay({ counterpartyIban: "de44 5001 0517 5407 3249 31" });
    await pay({ counterpartyIban: "DE44500105175407324931" });
    const aliases = await aliasesOf(t, personId);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatchObject({ iban: "DE44500105175407324931", source: "match_confirmed" });
    expect(aliases[0]?.token.length).toBeGreaterThan(0);
  });
});

describe("BNK-046 reject, BNK-043 auto-apply, „Alle sicheren bestätigen“", () => {
  test("BNK-046 rejecting the same pair twice stores it once", async () => {
    const { t, bankAccount, id } = await setup();
    const tx = await bookedTransaction(t, bankAccount, { bookingDate: "2026-10-12", amountCents: 1_000, purpose: "x" });
    const target = { kind: "salesDocument", id: id as string };
    await t.model(OWNER, (ctx) => rejectMatch(ctx, { transactionId: tx, target }));
    await t.model(OWNER, (ctx) => rejectMatch(ctx, { transactionId: tx, target }));
    expect(await t.run((ctx) => ctx.db.query("matchRejections").collect())).toHaveLength(1);
  });

  test("BNK-043 auto-apply does nothing for no rows or an account with the toggle off", async () => {
    const { t, bankAccount, number, id, name } = await setup();
    expect(await t.model(OWNER, (ctx) => autoApplyMatches(ctx, []))).toEqual([]);
    await t.model(OWNER, (ctx) =>
      auditedPatch(
        ctx,
        "bankAccounts",
        bankAccount,
        { autoApplyMatches: false },
        { action: "settings.bank_account.update" },
      ),
    );
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: number,
      counterpartyName: name,
    });
    expect(await t.model(OWNER, (ctx) => autoApplyMatches(ctx, [tx]))).toEqual([]);
    expect((await docOf(t, id)).paymentStatus).toBe("open");
  });

  test("BNK-046 „Alle sicheren bestätigen“ confirms only the selected safe rows", async () => {
    const { t, owner, bankAccount, number, id, name } = await setup();
    const safe = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: number,
      counterpartyName: name,
    });
    const unsafe = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 3_333,
      purpose: "irgendwas",
    });
    const notSelected = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: number,
    });
    const r = await owner.mutation(api.matching.confirmSafe, { transactionIds: [safe, unsafe] });
    expect(r).toEqual({ confirmed: [safe] });
    expect((await docOf(t, id)).paymentStatus).toBe("paid");
    expect((await txOf(t, unsafe)).status).toBe("open");
    expect((await txOf(t, notSelected)).status).toBe("open");
  });
});

describe("F07 §6.3 review card labels", () => {
  test("BNK-046 targets that no longer exist fall back to generic labels; unknown kinds show the kind", async () => {
    const { t } = await setup();
    const gone = await openingItem(t);
    await t.run((ctx) => ctx.db.delete(gone));
    const labels = await t.model(OWNER, (ctx) =>
      targetLabels(ctx, [
        { target: { kind: "salesDocument", id: gone }, amountCents: 1 },
        { target: { kind: "opening_item", id: gone }, amountCents: 2 },
        { target: { kind: "contactCredit", id: gone }, amountCents: 3 },
        { target: { kind: "payment", id: gone }, amountCents: 4 },
        { target: { kind: "voucher", id: gone }, amountCents: 5 },
        { target: { kind: "mystery" as never, id: "x" }, amountCents: 6 },
      ]),
    );
    expect(labels.map((l) => [l.label, l.contactName, l.openCents, l.dueDate, l.docType])).toEqual([
      ["Rechnung", "", 0, null, null],
      ["Offener Posten", "", 0, null, null],
      ["Guthaben", "", 0, null, null],
      ["Bereits erfasste Zahlung", "", 0, null, null],
      ["Beleg", "", 0, null, null],
      ["mystery", "", 0, null, null],
    ]);
  });

  test("BNK-046 an opening item and a manual payment are labelled with their number and amount", async () => {
    const { t, owner, bankAccount, id, personId } = await setup();
    const op = await openingItem(t, { contactId: personId, dueDate: "2026-01-31" });
    const manual = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 20_000,
    });
    const payId = manual.paymentIds[0] as Id<"payments">;
    const p = await t.run(async (ctx) => (await ctx.db.get(payId)) as Doc<"payments">);
    const labels = await t.model(OWNER, (ctx) =>
      targetLabels(ctx, [
        { target: { kind: "opening_item", id: op }, amountCents: 50_000 },
        { target: { kind: "payment", id: payId }, amountCents: 20_000 },
      ]),
    );
    expect(labels[0]).toMatchObject({
      label: `OP-${opN}`,
      contactName: "Altkunde Meier",
      openCents: 50_000,
      dueDate: "2026-01-31",
    });
    expect(labels[1]).toMatchObject({ label: `Bereits erfasste Zahlung ${p.number ?? ""}`.trim(), openCents: 20_000 });
  });
});

describe("BNK-040 match context", () => {
  test("BNK-040 open opening items are candidates (settled ones are not); contacts without data stay empty", async () => {
    const { t, personId } = await setup();
    await openingItem(t, { openAmountCents: 0 });
    const withContact = await openingItem(t, { contactId: personId, dueDate: "2026-02-01" });
    const anonymous = await openingItem(t);
    const ctx = await t.model(OWNER, (c) => matchContext(c));
    const items = ctx.documents.filter((d) => d.kind === "opening_item");
    expect(items.map((d) => d.id).sort()).toEqual([withContact, anonymous].sort());
    const a = items.find((d) => d.id === anonymous);
    expect(a).toMatchObject({ contactName: "Altkunde Meier", ibans: [], aliases: [], skonto: null, currency: "EUR" });
    expect(a?.contactId).toBeUndefined();
    expect(a?.dueDate).toBeUndefined();
    expect(items.find((d) => d.id === withContact)).toMatchObject({ contactId: personId, dueDate: "2026-02-01" });
  });

  test("PAY-047 reversed manual payments are no reconciliation candidates; PAY-030 a used-up credit is none either", async () => {
    const { t, owner, bankAccount, id, personId } = await setup();
    const manual = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 129_000,
      excess: { mode: "credit" },
    });
    let ctx = await t.model(OWNER, (c) => matchContext(c));
    expect(ctx.manualPayments?.length).toBeGreaterThan(0);
    expect(ctx.credits?.map((c) => [c.contactId, c.balanceCents])).toEqual([[personId, 10_000]]);
    for (const pid of manual.paymentIds) {
      await owner.mutation(api.payments.reverse, { paymentId: pid as Id<"payments">, reason: "Irrtum" });
    }
    ctx = await t.model(OWNER, (c) => matchContext(c));
    expect(ctx.manualPayments).toEqual([]);
    expect(ctx.credits).toEqual([]);
  });
});

describe("BNK-121 bank reversals", () => {
  test("BNK-121 linking a counter-entry to an unallocated original reverses nothing", async () => {
    const { t, bankAccount } = await setup();
    const original = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-10",
      amountCents: 5_000,
      purpose: "x",
      endToEndId: "E2E-U",
    });
    const counter = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-11",
      amountCents: -5_000,
      purpose: "Rückbuchung",
      endToEndId: "E2E-U",
      reversal: true,
    });
    const r = await t.model(OWNER, (ctx) => linkBankReversal(ctx, { counterId: counter, originalId: original }));
    expect(r).toEqual({ reversalIds: [], warnings: [] });
    expect((await txOf(t, counter)).reversalOfId).toBe(original);
  });

  test("E-ACC-24 a returned payment that went to a credit balance notifies „Guthaben“", async () => {
    const { t, bankAccount, personId } = await setup();
    const original = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-10",
      amountCents: 5_000,
      purpose: "Vorauszahlung",
      endToEndId: "E2E-C",
    });
    await t.model(OWNER, (ctx) =>
      confirmMatch(ctx, {
        transactionId: original,
        allocations: [{ target: { kind: "contactCredit", id: personId }, amountCents: 5_000 }],
      }),
    );
    const counter = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-11",
      amountCents: -5_000,
      purpose: "Rückbuchung",
      endToEndId: "E2E-C",
      reversal: true,
    });
    const r = await t.model(OWNER, (ctx) => linkBankReversal(ctx, { counterId: counter, originalId: original }));
    expect(r.reversalIds).toHaveLength(1);
    const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notes.map((n) => n.title)).toContain(
      "Zahlung vom 10.10.2026 wurde von der Bank zurückgebucht – Zahlung storniert, Guthaben wieder offen.",
    );
  });
});

// ── matching rules (BNK-050…054, BNK-064, BNK-065) ───────────────────────────────────────────────────────────────

let rawN = 0;
/** A booked row with every optional source field the mappers can fill (merchant, MCC, codes, instructed amount). */
const rawTx = (
  t: TestT,
  bank: Id<"bankAccounts">,
  tx: {
    bookingDate: string;
    amountCents: number;
    purpose: string;
    reference?: string;
    counterpartyName?: string;
    counterpartyIban?: string;
    status?: Doc<"bankTransactions">["status"];
  } & Partial<
    Pick<
      Doc<"bankTransactions">["source"],
      "merchantName" | "mcc" | "bankTransactionCode" | "proprietaryCode" | "instructedAmount"
    >
  >,
) => {
  const ref = `ER-RAW-${++rawN}`;
  const { bookingDate, amountCents, purpose, reference, counterpartyName, counterpartyIban, status, ...src } = tx;
  return t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankTransactions",
      {
        accountId: bank,
        bookingDate,
        amountCents,
        currency: "EUR",
        ...(counterpartyName ? { counterpartyName, counterpartySource: "statement" as const } : {}),
        ...(counterpartyIban ? { counterpartyIban } : {}),
        ...(reference ? { reference } : {}),
        purpose,
        source: { kind: "camt053", entryReference: ref, rawSha256: ref, ...src },
        sources: [],
        dedupeKey: `${bank}:er:${ref}`,
        contentHash: ref,
        status: status ?? "open",
        allocatedCents: 0,
        recordedAt: Date.now(),
      },
      { action: "bank.import", label: `${bookingDate} ${amountCents} EUR` },
    ),
  );
};

describe("BNK-050…054 rules (model branches)", () => {
  beforeEach(() => vi.setSystemTime(new Date(`${TODAY}T10:00:00Z`)));

  async function rules(opts: { ku?: boolean } = {}) {
    const t = makeT();
    const s = await setupCompany(t, { ku: opts.ku ?? true });
    const owner = await t.asUser("owner");
    return { t, owner, ...s };
  }
  const base = {
    priority: 10,
    enabled: true,
    when: { purposeContains: "fee" },
    apply: { action: "categorize" as const, account: "6855" },
  };

  test("BNK-050 invalid rules name the field; an invalid regex has its own reason; empty conditions are dropped", async () => {
    const s = await rules();
    const noAccount = await s.owner
      .mutation(api.matchingRules.create, { ...base, name: "A", apply: { action: "categorize" } })
      .catch((x: unknown) => x);
    expect(messageOf(noAccount)).toBe("Bitte das Konto für die Kategorisierung angeben.");
    expect(reasonOf(noAccount)).toBe("RULE_INVALID");
    expect((noAccount as { data: { field?: string } }).data.field).toBe("apply.account");
    const regex = await s.owner
      .mutation(api.matchingRules.create, { ...base, name: "B", when: { purposeRegex: "(a" } })
      .catch((x: unknown) => x);
    expect(reasonOf(regex)).toBe("RULE_REGEX_INVALID");
    expect((regex as { data: { field?: string } }).data.field).toBeUndefined();
    const ok = await s.owner.mutation(api.matchingRules.create, {
      ...base,
      name: "  Gebühren  ",
      when: { purposeContains: "fee", counterpartyContains: "", mccIn: [] },
    });
    const row = await s.t.run((ctx) => ctx.db.get(ok.id));
    expect(row).toMatchObject({ name: "Gebühren", when: { purposeContains: "fee" }, mode: "suggest" });
    expect(Object.keys(row?.when ?? {})).toEqual(["purposeContains"]);
  });

  test("BNK-050 rules of equal priority are listed by name; a removed rule can neither be edited nor removed again", async () => {
    const s = await rules();
    await s.owner.mutation(api.matchingRules.create, { ...base, name: "Zeta" });
    const alpha = await s.owner.mutation(api.matchingRules.create, { ...base, name: "Alpha" });
    expect((await s.owner.query(api.matchingRules.list, {})).map((r) => r.name)).toEqual(["Alpha", "Zeta"]);
    expect(await s.owner.query(api.matchingRules.get, { id: alpha.id })).toMatchObject({ name: "Alpha", hits90: 0 });
    // UI edit keeps the unchanged fields
    expect(await s.owner.mutation(api.matchingRules.update, { id: alpha.id, priority: 5 })).toEqual({
      mode: "suggest",
      warning: null,
    });
    expect(await s.t.run((ctx) => ctx.db.get(alpha.id))).toMatchObject({ name: "Alpha", priority: 5 });
    await s.owner.mutation(api.matchingRules.remove, { id: alpha.id });
    const upd = await s.owner.mutation(api.matchingRules.update, { id: alpha.id, name: "x" }).catch((x: unknown) => x);
    expect(errorCode(upd)).toBe("not_found");
    expect(messageOf(upd)).toBe("Die Regel existiert nicht.");
    const del = await s.owner.mutation(api.matchingRules.remove, { id: alpha.id }).catch((x: unknown) => x);
    expect(messageOf(del)).toBe("Die Regel existiert nicht.");
    expect(await s.owner.query(api.matchingRules.get, { id: alpha.id })).toBeNull();
  });

  test("BNK-054 an API rename of an auto rule keeps the automation (only conditions/actions drop it)", async () => {
    const s = await rules();
    const r = await s.owner.mutation(api.matchingRules.create, {
      ...base,
      name: "Auto",
      apply: { ...base.apply, statementSufficesAsVoucher: true },
      mode: "auto",
    });
    const key = await s.t.asApiKey(["banking:write"]);
    expect(await key.mutation(api.matchingRules.update, { id: r.id, name: "Auto umbenannt" })).toEqual({
      mode: "auto",
      warning: null,
    });
  });

  test("BNK-050 the matching rule is found with transfer and link-contact actions; all row fields reach the conditions", async () => {
    const s = await rules();
    const other = await s.t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankAccounts",
        {
          kind: "bank",
          name: "Revolut USD",
          currency: "USD",
          accountHolder: "Muster",
          autoApplyMatches: true,
          ledgerAccount: "1810",
          showOnInvoices: false,
          isDefaultForInvoices: false,
        },
        { action: "settings.bank_account.create" },
      ),
    );
    await s.owner.mutation(api.matchingRules.create, {
      name: "Umbuchung",
      priority: 1,
      enabled: true,
      when: { proprietaryCode: "TRANSFER", bankTransactionCode: "PMNT-ICDT-BOOK" },
      apply: { action: "transfer", transferTarget: { kind: "bank", accountId: other } },
    });
    await s.owner.mutation(api.matchingRules.create, {
      name: "Bargeld",
      priority: 2,
      enabled: true,
      when: { purposeContains: "ATM" },
      apply: { action: "transfer", transferTarget: { kind: "cash" } },
    });
    await s.owner.mutation(api.matchingRules.create, {
      name: "Lieferant",
      priority: 3,
      enabled: true,
      when: { merchantContains: "schmidt", mccIn: ["5943"] },
      apply: { action: "link_contact", contactId: s.supplier },
    });
    const transfer = await rawTx(s.t, s.bank, {
      bookingDate: TODAY,
      amountCents: -10_000,
      purpose: "To USD",
      proprietaryCode: "TRANSFER",
      bankTransactionCode: "PMNT-ICDT-BOOK",
      reference: "REF-1",
    });
    const atm = await rawTx(s.t, s.bank, { bookingDate: TODAY, amountCents: -5_000, purpose: "ATM Berlin" });
    const card = await rawTx(s.t, s.bank, {
      bookingDate: TODAY,
      amountCents: -1_990,
      purpose: "Card",
      merchantName: "Buero Schmidt",
      mcc: "5943",
      counterpartyName: "Buero Schmidt",
      counterpartyIban: "DE02120300000000202051",
    });
    expect(await s.owner.query(api.matchingRules.forTransaction, { transactionId: transfer })).toMatchObject({
      name: "Umbuchung",
      apply: { action: "transfer", transferTarget: { kind: "bank", accountId: other } },
    });
    expect(await s.owner.query(api.matchingRules.forTransaction, { transactionId: atm })).toMatchObject({
      name: "Bargeld",
      apply: { transferTarget: { kind: "cash" } },
    });
    expect(await s.owner.query(api.matchingRules.forTransaction, { transactionId: card })).toMatchObject({
      name: "Lieferant",
      apply: { action: "link_contact", contactId: s.supplier },
    });
    const p = await s.owner.query(api.matchingRules.preview, { when: { merchantContains: "schmidt" } });
    expect(p.hits).toEqual([expect.objectContaining({ id: card, counterpartyName: "Buero Schmidt", status: "open" })]);
    const atmPreview = await s.owner.query(api.matchingRules.preview, { when: { purposeContains: "ATM" } });
    expect(atmPreview.hits[0]?.counterpartyName).toBeNull();
  });

  test("BNK-050 a transaction that does not exist has no rule", async () => {
    const s = await rules();
    const gone = await rawTx(s.t, s.bank, { bookingDate: TODAY, amountCents: -1, purpose: "x" });
    await s.t.run((ctx) => ctx.db.delete(gone));
    expect(await s.t.model(OWNER, (ctx) => ruleFor(ctx, gone))).toBeNull();
  });

  test("BNK-053 three „privat“ marks of one counterparty propose a private rule", async () => {
    const s = await rules();
    for (let i = 0; i < 3; i++) {
      await rawTx(s.t, s.bank, {
        bookingDate: TODAY,
        amountCents: -2_000 - i,
        purpose: "Netflix",
        counterpartyName: "Netflix International",
        status: "private",
      });
    }
    const [sug] = await s.owner.query(api.matchingRules.suggestions, {});
    expect(sug).toMatchObject({ count: 3, apply: { action: "private" } });
  });

  test("BNK-052 categorizing needs a categorize rule", async () => {
    const s = await rules();
    const r = await s.owner.mutation(api.matchingRules.create, {
      name: "Privat",
      priority: 1,
      enabled: true,
      when: { purposeContains: "netflix" },
      apply: { action: "private" },
    });
    const tx = await rawTx(s.t, s.bank, { bookingDate: TODAY, amountCents: -2_000, purpose: "Netflix" });
    const e = await s.t
      .model(OWNER, (ctx) => categorizeByRule(ctx, { transactionId: tx, ruleId: r.id }))
      .catch((x: unknown) => x);
    expect(messageOf(e)).toBe("Keine Kategorisierungsregel.");
  });

  test("EC-BNK-72 BNK-052 an auto rule whose voucher does not validate stays a draft „Beleg fehlt“", async () => {
    const s = await rules({ ku: false });
    const r = await s.owner.mutation(api.matchingRules.create, {
      name: "Bewirtung",
      priority: 1,
      enabled: true,
      mode: "auto",
      when: { purposeContains: "restaurant" },
      apply: { action: "categorize", account: "6640", taxRule: "output_vat", statementSufficesAsVoucher: true },
    });
    const tx = await rawTx(s.t, s.bank, { bookingDate: TODAY, amountCents: -11_900, purpose: "Restaurant" });
    const out = await s.t.model(OWNER, (ctx) => categorizeByRule(ctx, { transactionId: tx, ruleId: r.id }));
    const v = await s.t.run(async (ctx) => (await ctx.db.get(out.voucherId)) as Doc<"vouchers">);
    expect(out.finalised).toBe(false);
    expect(v).toMatchObject({ status: "draft", receiptMissing: true, supplierName: "Revolut EUR" });
    expect(v.statementIsBeleg).toBeUndefined();
  });
});

describe("BNK-065 BNK-064 voucher drafts from transactions (model branches)", () => {
  beforeEach(() => vi.setSystemTime(new Date(`${TODAY}T10:00:00Z`)));

  async function company(ku = true) {
    const t = makeT();
    const s = await setupCompany(t, { ku });
    const owner = await t.asUser("owner");
    return { t, owner, ...s };
  }
  const linesOf = (t: TestT, id: Id<"vouchers">) =>
    t.run((ctx) =>
      ctx.db
        .query("voucherLines")
        .withIndex("by_voucher", (q) => q.eq("voucherId", id))
        .collect(),
    );

  test("BNK-065 the supplier profile of the counterparty IBAN suggests account and tax rule", async () => {
    const s = await company();
    await s.t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "supplierProfiles",
        {
          key: "iban:DE02120300000000202051",
          lastAccount: "6815",
          lastTaxRule: "no_input_vat",
          uses: 3,
          accountStreak: 3,
          updatedAt: Date.now(),
        },
        { action: "voucher.supplier_profile" },
      ),
    );
    const tx = await rawTx(s.t, s.bank, {
      bookingDate: TODAY,
      amountCents: -4_990,
      purpose: "Abo",
      counterpartyName: "Büro Schmidt GmbH",
      counterpartyIban: "DE02 1203 0000 0000 2020 51",
    });
    const id = await s.owner.mutation(api.matchingRules.createVoucherFromTransaction, { transactionId: tx });
    const v = await s.t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"vouchers">);
    expect(v).toMatchObject({ taxRule: "no_input_vat", supplierName: "Büro Schmidt GmbH", bankTransactionId: tx });
    expect((await linesOf(s.t, id)).map((l) => [l.account, l.description])).toEqual([["6815", "Abo"]]);
  });

  test("BNK-065 without counterparty, reference or profile the draft has no supplier and no lines", async () => {
    const s = await company();
    const tx = await rawTx(s.t, s.bank, { bookingDate: TODAY, amountCents: -700, purpose: "" });
    const id = await s.owner.mutation(api.matchingRules.createVoucherFromTransaction, { transactionId: tx });
    const v = await s.t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"vouchers">);
    expect(v.supplierName).toBeUndefined();
    expect(v.documentNumber).toBeUndefined();
    expect(v.currency).toBe("EUR");
    expect(await linesOf(s.t, id)).toEqual([]);
  });

  test("EC-BNK-76 BNK-065 a foreign card payment becomes a draft in the original currency and amount", async () => {
    const s = await company();
    const tx = await rawTx(s.t, s.bank, {
      bookingDate: TODAY,
      amountCents: -10_250,
      purpose: "Card payment",
      merchantName: "Acme Corp.",
      instructedAmount: { amountMinor: 11_900, currency: "USD" },
    });
    const id = await s.owner.mutation(api.matchingRules.createVoucherFromTransaction, {
      transactionId: tx,
      account: "6815",
    });
    const v = await s.t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"vouchers">);
    expect(v).toMatchObject({ currency: "USD", supplierName: "Acme Corp." });
    expect(v.internalNote).toContain("(Originalbetrag 119,00");
    expect((await linesOf(s.t, id))[0]?.grossCents).toBe(11_900);
  });

  test("BNK-064 a chosen tax-payment subtype without period on a row with reference and code", async () => {
    const s = await company(false);
    const tx = await rawTx(s.t, s.bank, {
      bookingDate: TODAY,
      amountCents: -30_000,
      purpose: "Zahlung",
      reference: "KASSENZEICHEN 123",
      proprietaryCode: "TRANSFER",
    });
    const id = await s.owner.mutation(api.matchingRules.createVoucherFromTransaction, {
      transactionId: tx,
      taxPayment: { subtype: "ust_annual" },
    });
    const v = await s.t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"vouchers">);
    expect(v).toMatchObject({ kind: "tax_payment", taxPayment: { subtype: "ust_annual" }, direction: "expense" });
    expect(v.taxPayment?.period).toBeUndefined();
    expect(v.supplierName).toBeUndefined();
    const [l] = await linesOf(s.t, id);
    expect(l?.description).toBe("KASSENZEICHEN 123 Zahlung");
    expect(l?.grossCents).toBe(30_000);
  });
});

describe("BNK-049 PAY-033 outgoing debits (model branches)", () => {
  beforeEach(() => vi.setSystemTime(new Date(`${TODAY}T10:00:00Z`)));

  test("BNK-049 an open expense voucher is a candidate; confirming with provenance records the match on the payment", async () => {
    const t = makeT();
    const s = await setupCompany(t);
    const owner = await t.asUser("owner");
    const draft = await owner.mutation(api.vouchers.create, {
      input: {
        direction: "expense",
        supplierName: "Büro Schmidt GmbH",
        documentNumber: "RS-77001",
        documentDate: TODAY,
        lines: [line({ vatRateBp: 0 })],
      },
    });
    const voucherId = (typeof draft === "string" ? draft : (draft as { id: Id<"vouchers"> }).id) as Id<"vouchers">;
    await upload(t, owner, { voucherId });
    await owner.mutation(api.vouchers.finalize, { id: voucherId });
    const ctx = await t.model(OWNER, (c) => matchContext(c));
    const v = ctx.vouchers?.find((x) => x.id === voucherId);
    expect(v).toMatchObject({ documentNumber: "RS-77001", supplierName: "Büro Schmidt GmbH", openCents: 11_900 });
    expect(v?.internalNumber).toMatch(/^BE-/);
    expect(v?.recurring).toBeUndefined();
    const tx = await bookedTransaction(t, s.bank, { bookingDate: TODAY, amountCents: -11_900, purpose: "RS-77001" });
    await t.model(OWNER, (c) =>
      confirmMatch(c, {
        transactionId: tx,
        allocations: [{ target: { kind: "voucher", id: voucherId }, amountCents: 11_900 }],
        acknowledgeWarnings: [],
        provenance: { score: 0.97, reasons: ["number_in_purpose", "exact_amount"], auto: false },
      }),
    );
    const pay = await t.run(async (c) =>
      (await c.db.query("payments").collect()).find((p) => p.bankTransactionId === tx),
    );
    expect(pay?.match).toMatchObject({ score: 0.97, auto: false });
    expect((await t.run((c) => c.db.get(voucherId)))?.status).toBe("paid");
    const labels = await t.model(OWNER, (c) =>
      targetLabels(c, [{ target: { kind: "voucher", id: voucherId }, amountCents: 11_900 }]),
    );
    expect(labels[0]?.label).toMatch(/^Beleg BE-/);
  });
});

describe("PAY-033 credit refunds (model branches)", () => {
  test("PAY-033 a refund of a credit balance keeps the match provenance and learns the counterparty", async () => {
    const { t, owner, bankAccount, id, personId } = await setup();
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 129_000,
      excess: { mode: "credit" },
    });
    const out = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: -10_000,
      purpose: "Erstattung",
      counterpartyName: "Erstattungsempfänger KG",
    });
    const r = await t.model(OWNER, (c) =>
      confirmMatch(c, {
        transactionId: out,
        allocations: [{ target: { kind: "contactCredit", id: personId }, amountCents: 10_000 }],
        provenance: { score: 0.9, reasons: ["exact_amount"], auto: false },
      }),
    );
    const pay = await t.run((c) => c.db.get((r as { refunded: Id<"payments"> }).refunded));
    expect(pay?.match).toMatchObject({ score: 0.9 });
    expect((await owner.query(api.payments.contactCredit, { contactId: personId })).balanceCents).toBe(0);
    expect((await aliasesOf(t, personId)).map((a) => a.source)).toEqual(["match_confirmed"]);
  });
});
