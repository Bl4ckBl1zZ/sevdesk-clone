import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { pdfText } from "../test/golden/pdf-text";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { dunningSetup } from "./dunning.fixtures";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedPatch } from "./model/audit";
import type { TestT } from "./test.setup";
import { makeT } from "./test.setup";

/**
 * F05 receivables letters (PAY-005 Kontoauszug, PAY-048 Zahlungsbestätigung, DUN-028 Zinsforderung, DUN-044
 * Mahnbescheid-Datenblatt): generated as PDF, archived with sha256, never sent by the app (B2), marked sent once.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);

async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

const textOf = (base64: string) => pdfText(new Uint8Array(Buffer.from(base64, "base64")));
const letterOf = (t: TestT, id: Id<"receivableLetters">) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"receivableLetters">);

async function partlyPaid(t: TestT) {
  const f = await finalizedInvoice(t);
  const id = f.id as Id<"salesDocuments">;
  const r = await f.owner.mutation(api.payments.recordForInvoice, {
    documentId: id,
    source: { kind: "cash" },
    date: "2026-10-12",
    amountCents: 50_000,
  });
  return { ...f, id, paymentId: r.paymentIds[0] as Id<"payments"> };
}

describe("F05 receivables letters", () => {
  test("PAY-005 the customer account statement lists the invoice and the payment with the running balance; archived", async () => {
    const t = makeT();
    const { owner, personId, id } = await partlyPaid(t);
    const number = (await t.run(async (ctx) => (await ctx.db.get(id))?.number)) as string;
    const r = await owner.action(api.payments.letter, {
      request: {
        kind: "account_statement",
        contactId: personId as Id<"contacts">,
        from: "2026-10-01",
        to: "2026-10-12",
      },
    });
    const text = await textOf(r.pdfBase64);
    expect(text).toContain("Kontoauszug vom 01.10.2026 bis 12.10.2026");
    expect(text).toContain(number);
    expect(text).toContain("1.190,00 €");
    expect(text).toContain("690,00 €");
    expect(text).toMatch(/Zum 12\.10\.2026 besteht ein offener Saldo zu unseren Gunsten von 690,00/);
    const row = await letterOf(t, r.letterId);
    expect(row).toMatchObject({ kind: "account_statement", contactId: personId, date: "2026-10-12" });
    expect(row.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    const list = await owner.query(api.payments.letters, { contactId: personId as Id<"contacts"> });
    expect(list.map((l) => [l.kind, l.title, l.sent])).toEqual([["account_statement", "Kontoauszug", null]]);
    const future = await catching(
      owner.query(api.payments.letterPreview, {
        request: {
          kind: "account_statement",
          contactId: personId as Id<"contacts">,
          from: "2026-10-01",
          to: "2026-10-13",
        },
      }),
    );
    expect(errorCode(future)).toBe("invalid_input");
  });

  test("PAY-048 the payment confirmation names amount, date, invoice and the rest; marked sent once, then immutable", async () => {
    const t = makeT();
    const { owner, id, paymentId } = await partlyPaid(t);
    const number = (await t.run(async (ctx) => (await ctx.db.get(id))?.number)) as string;
    const r = await owner.action(api.payments.letter, { request: { kind: "payment_confirmation", paymentId } });
    const text = await textOf(r.pdfBase64);
    expect(text).toContain(`Bestätigung Ihres Zahlungseingangs zur Rechnung ${number}`);
    expect(text).toMatch(/Zahlung über 500,00\s€ vom 12\.10\.2026/);
    expect(text).toMatch(/Es verbleibt ein offener Betrag von 690,00/);
    expect(await letterOf(t, r.letterId)).toMatchObject({ kind: "payment_confirmation", paymentId, documentId: id });

    const early = await catching(
      owner.mutation(api.payments.markLetterSent, { id: r.letterId, sentOn: "2026-10-11", channel: "post" }),
    );
    expect(messageOf(early)).toBe(
      "Das Versanddatum muss zwischen dem Datum des Schreibens (12.10.2026) und heute liegen.",
    );
    await owner.mutation(api.payments.markLetterSent, { id: r.letterId, sentOn: "2026-10-12", channel: "post" });
    expect((await letterOf(t, r.letterId)).sent).toMatchObject({ sentOn: "2026-10-12", channel: "post" });
    const again = await catching(
      owner.mutation(api.payments.markLetterSent, { id: r.letterId, sentOn: "2026-10-12", channel: "post" }),
    );
    expect(errorCode(again)).toBe("conflict");
    const patched = await catching(
      t.model(OWNER, (ctx) =>
        auditedPatch(ctx, "receivableLetters", r.letterId, { subject: "geändert" }, { action: "test.patch" }),
      ),
    );
    expect(String(messageOf(patched))).toContain("Archivierte Schreiben sind unveränderbar (GoBD).");
  });

  test("DUN-028 after a late full payment the interest claim lists the § 288 interest and the 40 € flat fee", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const open = await catching(
      s.owner.query(api.payments.letterPreview, { request: { kind: "interest_claim", invoiceId: s.invoiceId } }),
    );
    expect(messageOf(open)).toBe(
      "Die Hauptforderung ist noch offen. Bitte eine Mahnung erstellen – sie enthält Zinsen und Kosten.",
    );
    vi.setSystemTime(new Date("2026-12-14T08:00:00Z"));
    const owner = await t.asUser("owner", { existingUserId: s.owner.userId });
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: s.invoiceId,
      source: { kind: "cash" },
      date: "2026-12-14",
      amountCents: 119_000,
    });
    const r = await owner.action(api.payments.letter, { request: { kind: "interest_claim", invoiceId: s.invoiceId } });
    const text = await textOf(r.pdfBase64);
    expect(text).toMatch(/Verzugszinsen und Kosten zur Rechnung/);
    expect(text).toMatch(/40,00\s€/);
    expect(text).toMatch(/9\s+Prozentpunkten\s+über\s+dem\s+jeweiligen\s+Basiszinssatz\s+\(§\s288\s+Abs\.\s+2\s+BGB\)/);
    expect(await letterOf(t, r.letterId)).toMatchObject({ kind: "interest_claim", documentId: s.invoiceId });
  });

  test("DUN-044 the Mahnbescheid data sheet exports the claim as PDF and JSON (archived with the data)", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    vi.setSystemTime(new Date("2026-12-01T08:00:00Z"));
    const owner = await t.asUser("owner", { existingUserId: s.owner.userId });
    const r = await owner.action(api.payments.letter, {
      request: { kind: "mahnbescheid_sheet", invoiceId: s.invoiceId },
    });
    const data = JSON.parse(r.data ?? "null");
    expect(data.anspruch).toMatchObject({ hauptforderungCents: 119_000, faelligAm: "2026-10-12" });
    expect(data.antragsgegner.art).toBe("Firma / juristische Person"); // the person's organisation is the debtor
    expect(data.zinsen?.prozentpunkte).toBe(9);
    expect(data.nebenforderungen.pauschale288Abs5Cents).toBe(4_000);
    const text = await textOf(r.pdfBase64);
    expect(text).toContain("Daten für den Antrag auf Erlass eines Mahnbescheids");
    expect((await letterOf(t, r.letterId)).data).toBe(r.data);
  });
});
