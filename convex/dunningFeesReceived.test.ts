import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type DunningOwner, dunningSetup, markSent } from "./dunning.fixtures";
import { invoiceValues, settle } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import type { TestT } from "./test.setup";
import { makeT } from "./test.setup";

/**
 * F05 PAY-024: an overpayment up to the fees, the 40 € flat fee and the interest claimed by the latest issued
 * reminder is recorded as `dunning_fees` / `default_interest`; DUN-028/DUN-044 letters net what was received.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);
const reasonOf = (e: unknown) => dataOf(e).reason;

async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

/** L1 on 2026-10-19 marked sent by post; L2 with a 5 € fee on 2026-11-05 finalised and marked sent by e-mail. */
async function secondReminderSent(t: TestT) {
  const s = await dunningSetup(t);
  const jump = async (owner: DunningOwner, iso: string) => {
    vi.setSystemTime(new Date(iso));
    return t.asUser("owner", { existingUserId: owner.userId });
  };
  let owner = await jump(s.owner, "2026-10-19T08:00:00Z");
  const r1 = (await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} }))
    .id as Id<"salesDocuments">;
  await owner.mutation(api.dunning.finalize, { id: r1 });
  await settle(t);
  await markSent(owner, r1, "2026-10-19", "post");
  owner = await jump(owner, "2026-11-05T08:00:00Z");
  const values = { feeCents: 500 };
  // EC-DUN-07: an own fee next to the 40 € is a warning to acknowledge.
  const first = await catching(owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values }));
  const ack = String(dataOf(first).warnings ?? "")
    .split(",")
    .filter(Boolean);
  const r2 = (
    await owner.mutation(api.dunning.createReminder, {
      invoiceId: s.invoiceId,
      values: { ...values, acknowledgeWarnings: ack },
    })
  ).id as Id<"salesDocuments">;
  await owner.mutation(api.dunning.finalize, { id: r2, acknowledgeWarnings: ack });
  await settle(t);
  await markSent(owner, r2, "2026-11-05", "email_manual");
  const reminder = (await t.run(async (ctx) => (await ctx.db.get(r2)) as Doc<"salesDocuments">)).reminder;
  return { ...s, owner, r1, r2, reminder: reminder as NonNullable<typeof reminder> };
}

describe("PAY-024 dunning fees and interest received", () => {
  test("PAY-024 an overpayment up to the latest reminder's fees, flat fee and interest is recorded as fees/interest; more is refused", async () => {
    const t = makeT();
    const { owner, invoiceId, bankAccount, reminder } = await secondReminderSent(t);
    expect(reminder).toMatchObject({ feeCents: 500, flatFee40Cents: 4_000 });
    expect(reminder.interestCents).toBeGreaterThan(0);
    const claimed = 500 + 4_000 + reminder.interestCents;
    const pay = (amountCents: number) =>
      owner.mutation(api.payments.recordForInvoice, {
        documentId: invoiceId,
        source: { kind: "clearing", accountId: bankAccount },
        date: "2026-11-05",
        amountCents,
        excess: { mode: "fees" },
      });
    const tooMuch = await catching(pay(119_000 + claimed + 1));
    expect(errorCode(tooMuch)).toBe("invalid_input");
    expect(reasonOf(tooMuch)).toBe("FEES_EXCEED_CLAIM");
    const r = await pay(119_000 + claimed);
    const payment = await t.run((ctx) => ctx.db.get(r.paymentIds[0] as Id<"payments">));
    expect(payment?.differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "dunning_fees", amountCents: -4_500 }),
        expect.objectContaining({ reason: "default_interest", amountCents: -reminder.interestCents }),
      ]),
    );
    expect((await t.run((ctx) => ctx.db.get(invoiceId)))?.paymentStatus).toBe("paid");
  });

  test("DUN-044 DUN-028 PAY-024 the sheet counts issued reminder fees; after payment with the fees received the interest claim nets them", async () => {
    const t = makeT();
    const { owner, invoiceId, bankAccount } = await secondReminderSent(t);
    const sheet = await owner.query(api.payments.letterPreview, {
      request: { kind: "mahnbescheid_sheet", invoiceId },
    });
    const data = JSON.parse(sheet.data ?? "null");
    expect(data.nebenforderungen).toMatchObject({ pauschale288Abs5Cents: 4_000 });
    expect(JSON.stringify(data.nebenforderungen)).toContain("500");

    const draft = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues((await t.run((ctx) => ctx.db.get(invoiceId)))?.contactId as string),
    });
    for (const kind of ["interest_claim", "mahnbescheid_sheet"] as const) {
      const e = await catching(
        owner.query(api.payments.letterPreview, {
          request: { kind, invoiceId: draft.id as Id<"salesDocuments"> },
        }),
      );
      expect(errorCode(e)).toBe("not_found");
      expect(messageOf(e)).toBe("Die Rechnung existiert nicht.");
    }

    await owner.mutation(api.payments.recordForInvoice, {
      documentId: invoiceId,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-11-05",
      amountCents: 119_500,
      differences: [{ reason: "dunning_fees", amountCents: -500 }],
    });
    const claim = await owner.query(api.payments.letterPreview, { request: { kind: "interest_claim", invoiceId } });
    expect(claim.links).toMatchObject({ documentId: invoiceId });
    expect(claim.content.kind).toBe("interest_claim");
    expect(JSON.stringify(claim.content.table)).toMatch(/40,00/);
  });
});
