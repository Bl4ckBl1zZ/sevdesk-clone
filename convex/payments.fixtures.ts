import type { Id } from "./_generated/dataModel";
import { auditedInsert } from "./model/audit";
import type { TestT } from "./test.setup";

/**
 * Payment-slice fixtures (not a Convex module: multi-dot file name). Booked bank transactions are inserted through
 * the model layer exactly as the statement import stores them (03 §7), without parsing a file.
 */

const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
let n = 0;

export async function bookedTransaction(
  t: TestT,
  accountId: Id<"bankAccounts">,
  tx: {
    bookingDate: string;
    amountCents: number;
    purpose: string;
    counterpartyName?: string;
    counterpartyIban?: string;
    reference?: string;
    endToEndId?: string;
    reversal?: boolean;
  },
): Promise<Id<"bankTransactions">> {
  const i = n++;
  const raw = `fixture-${i}-${tx.bookingDate}-${tx.amountCents}`;
  return t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankTransactions",
      {
        accountId,
        bookingDate: tx.bookingDate,
        amountCents: tx.amountCents,
        currency: "EUR",
        ...(tx.counterpartyName
          ? { counterpartyName: tx.counterpartyName, counterpartySource: "statement" as const }
          : {}),
        ...(tx.counterpartyIban ? { counterpartyIban: tx.counterpartyIban } : {}),
        purpose: tx.purpose,
        ...(tx.reference ? { reference: tx.reference } : {}),
        ...(tx.endToEndId ? { endToEndId: tx.endToEndId } : {}),
        ...(tx.reversal ? { reversal: true } : {}),
        source: { kind: "camt053", entryReference: `ER-${i}`, rawSha256: raw },
        sources: [],
        dedupeKey: `${accountId}:er:ER-${i}`,
        contentHash: raw,
        status: "open",
        allocatedCents: 0,
        recordedAt: Date.now(),
      },
      { action: "bank.import", label: `${tx.bookingDate} ${tx.amountCents} EUR` },
    ),
  );
}
