import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { BERLIN, createValues, orgForm } from "../../convex/catalog.fixtures";
import type { DraftValues } from "../../src/domain/schemas/documents";
import type { Scope } from "../../src/domain/schemas/scopes";
import type { CalendarDate } from "../../src/domain/time/calendar-date";

/**
 * F05 T05-163 (PAY-062, PAY-033 b, EC-PAY-33, EC-149, RI-11): two cash refunds („Bar erstattet“) on the same
 * Rechnungskorrektur fired at the same time. One scenario for two backends — convex-test (convex project) and the
 * real self-hosted backend (integration project, real OCC) — driven through the public Convex API with an API key,
 * so both runs exercise the same wrappers, checks and postings.
 *
 * Invoice T-GLD-01 (10 h × 100,00 + 19 % = 1.190,00) is paid **in cash** (the till grows by 1.190,00), then a credit
 * correction of −238,00 (8 instead of 10 hours) leaves 238,00 to refund.
 */

/** Anything that calls Convex as one principal: a convex-test accessor or `httpBackend(principal)`. */
export interface Caller {
  query<Q extends FunctionReference<"query">>(ref: Q, args: FunctionArgs<Q>): Promise<FunctionReturnType<Q>>;
  mutation<M extends FunctionReference<"mutation">>(ref: M, args: FunctionArgs<M>): Promise<FunctionReturnType<M>>;
  action<A extends FunctionReference<"action">>(ref: A, args: FunctionArgs<A>): Promise<FunctionReturnType<A>>;
}

export const REFUND_RACE_SCOPES: readonly Scope[] = [
  "contacts:read",
  "contacts:write",
  "documents:read",
  "documents:write",
  "invoices:finalize",
  "invoices:cancel",
  "payments:read",
  "payments:write",
  "banking:read",
  "banking:write",
];

export const OPEN_REFUND_CENTS = 23_800;

function invoiceDraft(contactId: string): DraftValues {
  return {
    type: "invoice",
    contactId,
    supplyDateMode: "explicit",
    supplyDate: { kind: "date", date: "2026-10-09" as CalendarDate },
    currency: "EUR",
    priceMode: "net",
    paymentTerms: { dueDays: 30 },
    showEpcQr: false,
    language: "de",
    lines: [
      {
        kind: "item",
        productType: "service",
        name: "Beratung Webdesign",
        description: "Konzeption der Startseite",
        quantityMilli: 10_000,
        unitCode: "HUR",
        unitPriceMicros: 1_000_000,
        vatRateKey: "standard",
      },
    ],
  };
}

/**
 * A finalised credit correction with 238,00 open refund whose invoice was paid in cash today (`today` = the Berlin
 * date of the backend's clock). `settle` drains the scheduled render jobs (convex-test); the real backend runs them.
 */
export async function cashPaidCreditCorrection(
  caller: Caller,
  opts: { today: string; settle?: () => Promise<void>; label?: string },
): Promise<{ correctionId: Id<"salesDocuments">; invoiceId: Id<"salesDocuments"> }> {
  const settle = opts.settle ?? (async () => {});
  const name = `Erstattung ${opts.label ?? crypto.randomUUID().slice(0, 8)} GmbH`;
  const contact = await caller.mutation(api.contacts.create, {
    values: createValues(orgForm(name), { address: { ...BERLIN }, email: "buchhaltung@example.test" }),
  });
  const { id } = await caller.mutation(api.invoices.createDraft, { values: invoiceDraft(contact.id) });
  const invoiceId = id as Id<"salesDocuments">;
  await caller.action(api.invoices.finalize, { id: invoiceId, version: 1 });
  await settle();
  await caller.mutation(api.payments.recordForInvoice, {
    documentId: invoiceId,
    source: { kind: "cash" },
    date: opts.today,
    amountCents: 119_000,
  });
  const { id: cid } = await caller.mutation(api.corrections.createCorrection, {
    originalId: invoiceId,
    kind: "credit",
    changes: [{ position: 1, quantityMilli: 8_000 }],
  });
  const correctionId = cid as Id<"salesDocuments">;
  const head = await caller.query(api.documentsApi.head, { id: correctionId });
  await caller.action(api.invoices.finalize, { id: correctionId, version: head?.version ?? 1 });
  await settle();
  return { correctionId, invoiceId };
}

/** Brings the till to exactly `cents` today by depositing the surplus to the bank (Geldtransit, CSH-024). */
export async function tillTo(caller: Caller, today: string, cents: number): Promise<void> {
  const cash = await caller.query(api.cash.overview, {});
  const surplus = cash.balanceCents - cents;
  if (surplus < 0) throw new Error(`till ${cash.balanceCents} below ${cents}`);
  if (surplus === 0) return;
  const bank = cash.bankAccounts[0];
  if (!bank) throw new Error("no EUR bank account for the deposit");
  await caller.action(api.cash.recordTransfer, {
    kind: "deposit_to_bank",
    date: today,
    amountCents: surplus,
    bankAccountId: bank.id,
  });
}

/** Both refunds start before either finishes; each caller is its own client (no shared mutation queue). */
export function raceCashRefunds(
  callers: readonly [Caller, Caller],
  correctionId: Id<"salesDocuments">,
  amounts: readonly [number, number],
  today: string,
): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(
    callers.map((c, i) =>
      c.mutation(api.payments.refundCorrection, {
        documentId: correctionId,
        amountCents: amounts[i] as number,
        source: { kind: "cash" },
        date: today,
        note: `Bar erstattet (parallel ${i + 1})`,
      }),
    ),
  );
}

/** The ConvexError payload (`{ code, reason, message }`) of a rejected call. */
export function errorData(e: unknown): { code?: string; reason?: string; message?: string } {
  const data = (e as { data?: unknown }).data;
  return typeof data === "object" && data !== null ? (data as { code?: string }) : {};
}
