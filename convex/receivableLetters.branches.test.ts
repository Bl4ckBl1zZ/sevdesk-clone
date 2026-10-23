import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CONTACT_RANGE, createValues, orgForm, PRODUCT_RANGE, personForm } from "./catalog.fixtures";
import { dunningSetup } from "./dunning.fixtures";
import { b2bBuyer, INVOICE_RANGE, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import type { TestT } from "./test.setup";
import { makeT } from "./test.setup";

/**
 * F05 receivables letters — the branches of the letter builders: the addressee (organisation, „z. Hd.“, foreign
 * address), the company footer (MAIL-03), the statement period and its rows (PAY-005), the confirmable payments
 * (PAY-048), the invoice facts of the interest claim and the Mahnbescheid sheet (DUN-028, DUN-044) and the one-time
 * sent mark.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
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

type Owner = Awaited<ReturnType<typeof setupInvoicing>>["owner"];
const asOwner = (owner: Owner) => ({ actor: owner.actor, role: "owner", channel: "ui" }) as const;

async function finalized(t: TestT, owner: Owner, contactId: string) {
  const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(contactId) });
  await owner.action(api.invoices.finalize, { id, version: 1 });
  await settle(t);
  return id as Id<"salesDocuments">;
}

describe("PAY-005 MAIL-03 account statement", () => {
  test("PAY-005 MAIL-03 the statement of an organisation covers its persons, opening items and payments; the footer shows trade name, chair and the printable account", async () => {
    const t = makeT();
    const s = await setupInvoicing(t);
    await s.owner.mutation(api.settings.saveNumberRanges, {
      values: { ranges: [CONTACT_RANGE, PRODUCT_RANGE, INVOICE_RANGE] },
    });
    const { orgId, personId } = await b2bBuyer(s.owner);
    const invoiceId = await finalized(t, s.owner, personId);
    await s.owner.mutation(api.payments.recordForInvoice, {
      documentId: invoiceId,
      source: { kind: "cash" },
      date: "2026-10-12",
      amountCents: 19_000,
    });
    await s.owner.mutation(api.accounting.postOpeningBalancePart, {
      fiscalYear: 2026,
      part: {
        kind: "receivables",
        items: [
          {
            number: "SD-0815",
            documentDate: "2025-12-10",
            counterpartyName: "Beispiel GmbH",
            contactId: orgId,
            grossCents: 50_000,
            openCents: 50_000,
            taxedAs: "soll",
          },
        ],
      },
    });
    await t.model(asOwner(s.owner), async (ctx) => {
      const profile = await ctx.db.query("companyProfile").first();
      await patchCompanyProfile(
        ctx,
        {
          tradeName: "Webdesign Studio",
          address: { ...(profile?.address as NonNullable<typeof profile>["address"]), poBox: "10 12 34" },
          generalPartner: {
            name: "Verwaltungs GmbH",
            seat: "Berlin",
            registerCourt: "Amtsgericht Charlottenburg",
            registerNumber: "HRB 999",
            managingDirectors: ["Erika Muster"],
          },
          supervisoryBoardChair: "Dr. Hans Aufsicht",
        },
        { action: "settings.company.update" },
      );
      // An EUR account without IBAN/BIC that is shown on documents, and a hidden USD account.
      await auditedInsert(
        ctx,
        "bankAccounts",
        {
          kind: "paypal",
          name: "PayPal",
          currency: "EUR",
          accountHolder: "Muster GmbH",
          ledgerAccount: "1361",
          showOnInvoices: true,
          isDefaultForInvoices: false,
          autoApplyMatches: false,
        },
        { action: "settings.bank_account.create" },
      );
    });

    const r = await s.owner.query(api.payments.letterPreview, {
      request: {
        kind: "account_statement",
        contactId: orgId,
        from: "2025-12-01",
        to: "2026-10-12",
        confirmationRequest: true,
      },
    });
    expect(r.links).toEqual({ contactId: orgId });
    expect(r.content.recipient[0]).toBe("Beispiel Kunde GmbH");
    expect(r.content.recipient).not.toContain("z. Hd. Max Beispiel");
    const rows = JSON.stringify(r.content.table);
    expect(rows).toContain("SD-0815");
    expect(rows).toContain((await t.run((ctx) => ctx.db.get(invoiceId)))?.number as string);
    expect(rows).toContain("190,00");
    const footer = r.content.footer.flat().join("\n");
    expect(footer).toContain("Webdesign Studio");
    // The Komplementär line is a KG-form field: a GmbH footer does not print it (src/domain/company/footer.ts).
    expect(footer).not.toContain("Verwaltungs GmbH");
    expect(footer).toContain("Dr. Hans Aufsicht");
    // Only accounts with an IBAN are printable; the default account comes first (SET-051).
    expect(footer).not.toContain("PayPal");
    expect(footer).toMatch(/IBAN/);
    expect(r.content.title).toBe("Saldenbestätigung");
    expect(r.content.subject).toBe("Saldenbestätigung vom 01.12.2025 bis 12.10.2026");

    // The person's statement is addressed to the organisation „z. Hd.“ the person.
    const person = await s.owner.query(api.payments.letterPreview, {
      request: { kind: "account_statement", contactId: personId, from: "2026-10-01", to: "2026-10-12" },
    });
    expect(person.content.recipient.slice(0, 2)).toEqual(["Beispiel Kunde GmbH", "z. Hd. Max Beispiel"]);
  });

  test("PAY-005 the period must be valid and must not end in the future; a foreign or missing address is printed as is (KU footer)", async () => {
    const t = makeT();
    const s = await setupInvoicing(t, { seller: "ku" });
    await s.owner.mutation(api.settings.saveNumberRanges, { values: { ranges: [CONTACT_RANGE, PRODUCT_RANGE] } });
    const foreign = await s.owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Alpen Handel GmbH"), {
        address: { street: "Ringstraße 1", postalCode: "1010", city: "Wien", countryCode: "AT" },
      }),
    });
    const noAddress = await s.owner.mutation(api.contacts.create, {
      values: createValues(personForm("Paul", "Ohneadresse")),
    });
    const contactId = foreign.id as Id<"contacts">;
    for (const [from, to] of [
      ["2026-13-01", "2026-10-01"],
      ["2026-10-01", "kein Datum"],
      ["2026-10-05", "2026-10-01"],
    ] as const) {
      const e = await catching(
        s.owner.query(api.payments.letterPreview, { request: { kind: "account_statement", contactId, from, to } }),
      );
      expect(errorCode(e)).toBe("invalid_input");
      expect(messageOf(e)).toBe("Bitte einen gültigen Zeitraum angeben.");
      expect(dataOf(e).field).toBe("from");
    }
    const future = await catching(
      s.owner.query(api.payments.letterPreview, {
        request: { kind: "account_statement", contactId, from: "2026-10-01", to: "2026-10-13" },
      }),
    );
    expect(messageOf(future)).toBe("Der Zeitraum darf nicht in der Zukunft enden.");

    const r = await s.owner.query(api.payments.letterPreview, {
      request: { kind: "account_statement", contactId, from: "2026-10-01", to: "2026-10-12" },
    });
    expect(r.content.recipient).toEqual(["Alpen Handel GmbH", "Ringstraße 1", "1010 Wien", "AT"]);
    const footer = r.content.footer.flat().join("\n");
    expect(footer).not.toMatch(/HRB|Stammkapital|USt-IdNr/);
    const bare = await s.owner.query(api.payments.letterPreview, {
      request: {
        kind: "account_statement",
        contactId: noAddress.id as Id<"contacts">,
        from: "2026-10-01",
        to: "2026-10-12",
      },
    });
    expect(bare.content.recipient).toEqual(["Paul Ohneadresse"]);
  });
});

describe("PAY-048 payment confirmation", () => {
  test("PAY-048 only recorded, not reversed incoming payments on invoices can be confirmed; English text and an own template", async () => {
    const t = makeT();
    const s = await setupInvoicing(t);
    await s.owner.mutation(api.settings.saveNumberRanges, {
      values: { ranges: [CONTACT_RANGE, PRODUCT_RANGE, INVOICE_RANGE] },
    });
    const { personId } = await b2bBuyer(s.owner);
    const invoiceId = await finalized(t, s.owner, personId);
    const pay = async (amountCents: number) =>
      (
        await s.owner.mutation(api.payments.recordForInvoice, {
          documentId: invoiceId,
          source: { kind: "cash" },
          date: "2026-10-12",
          amountCents,
        })
      ).paymentIds[0] as Id<"payments">;
    const reversed = await pay(10_000);
    await s.owner.mutation(api.payments.reverse, { paymentId: reversed, reason: "Falsch erfasst" });
    const reversal = (await t.run((ctx) => ctx.db.get(reversed)))?.reversedById as Id<"payments">;
    for (const paymentId of [reversed, reversal]) {
      const e = await catching(
        s.owner.query(api.payments.letterPreview, { request: { kind: "payment_confirmation", paymentId } }),
      );
      expect(errorCode(e)).toBe("invalid_input");
      expect(reasonOf(e)).toBe("NOT_CONFIRMABLE");
      expect(messageOf(e)).toBe(
        "Eine Zahlungsbestätigung gibt es nur für erfasste, nicht stornierte Zahlungseingänge auf Rechnungen.",
      );
    }

    const ok = await pay(20_000);
    const en = await s.owner.query(api.payments.letterPreview, {
      request: { kind: "payment_confirmation", paymentId: ok, lang: "en" },
    });
    expect(en.content.paragraphs.join(" ")).toMatch(/Dear Sir or Madam/);
    expect(en.links).toMatchObject({ documentId: invoiceId, paymentId: ok });
    const own = await s.owner.query(api.payments.letterPreview, {
      request: {
        kind: "payment_confirmation",
        paymentId: ok,
        subject: "  Danke für Ihre Zahlung  ",
        body: "  Wir haben Ihre Zahlung erhalten.  ",
      },
    });
    expect(own.content.subject).toBe("Danke für Ihre Zahlung");
    expect(own.content.paragraphs.join(" ")).toContain("Wir haben Ihre Zahlung erhalten.");
    // Subject without body: the standard text is used.
    const half = await s.owner.query(api.payments.letterPreview, {
      request: { kind: "payment_confirmation", paymentId: ok, subject: "Nur Betreff", body: "   " },
    });
    expect(half.content.subject).not.toBe("Nur Betreff");
  });
});

describe("PAY-048 B2 sent mark and archive list", () => {
  test("PAY-048 „Sonstiges“ needs a note; the sent date must be a valid date; letters are listed per document; no filter lists nothing", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    vi.setSystemTime(new Date("2026-12-01T08:00:00Z"));
    const owner = await t.asUser("owner", { existingUserId: s.owner.userId });
    const r = await owner.action(api.payments.letter, {
      request: { kind: "mahnbescheid_sheet", invoiceId: s.invoiceId },
    });
    const noNote = await catching(
      owner.mutation(api.payments.markLetterSent, { id: r.letterId, sentOn: "2026-12-01", channel: "other" }),
    );
    expect(errorCode(noNote)).toBe("invalid_input");
    expect(messageOf(noNote)).toBe("Bitte beschreiben, wie das Schreiben übermittelt wurde.");
    const badDate = await catching(
      owner.mutation(api.payments.markLetterSent, { id: r.letterId, sentOn: "1.12.2026", channel: "post" }),
    );
    expect(messageOf(badDate)).toBe(
      "Das Versanddatum muss zwischen dem Datum des Schreibens (01.12.2026) und heute liegen.",
    );
    await owner.mutation(api.payments.markLetterSent, {
      id: r.letterId,
      sentOn: "2026-12-01",
      channel: "other",
      note: "  dem Anwalt übergeben  ",
    });
    const byDoc = await owner.query(api.payments.letters, { documentId: s.invoiceId });
    expect(byDoc.map((l) => [l.kind, l.hasData, l.sent])).toEqual([
      ["mahnbescheid_sheet", true, { sentOn: "2026-12-01", channel: "other", note: "dem Anwalt übergeben" }],
    ]);
    expect(await owner.query(api.payments.letters, {})).toEqual([]);
  });
});
