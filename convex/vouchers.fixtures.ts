import { berlinCalendarDate } from "../src/domain/time/berlin";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditedInsert } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { saveRanges } from "./model/numberRanges";
import type { TestT } from "./test.setup";

/**
 * Voucher-slice fixtures (not a Convex module: multi-dot file name). A company (regular or Kleinunternehmer,
 * Einzelunternehmen or GmbH, SKR04 by default), the voucher number range BE-{YYYY}-{#####}, a bank account, a supplier
 * contact, and a stored PDF original uploaded through the real `attachFile` action.
 */

export const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
export const TODAY = berlinCalendarDate(Date.now());
export const YEAR = Number(TODAY.slice(0, 4));

export interface VoucherSetup {
  bank: Id<"bankAccounts">;
  supplier: Id<"contacts">;
}

export async function setupCompany(
  t: TestT,
  opts: { ku?: boolean; legalForm?: "einzelunternehmen" | "gmbh"; chart?: "SKR03" | "SKR04"; vatId?: string } = {},
): Promise<VoucherSetup> {
  const chart = opts.chart ?? "SKR04";
  await t.model(OWNER, (ctx) =>
    patchCompanyProfile(
      ctx,
      {
        name: opts.legalForm === "gmbh" ? "Muster Design GmbH" : "Muster Design",
        legalForm: opts.legalForm ?? "einzelunternehmen",
        chartOfAccounts: [{ validFromFiscalYear: 2020, chart }],
        taxationMethod: [{ validFrom: "2020-01-01", method: "soll" }],
        ustvaPeriod: [{ year: YEAR, period: "monthly", dauerfrist: false }],
        kleinunternehmer: [{ validFrom: "2020-01-01", isKU: opts.ku ?? false }],
        ...(opts.vatId ? { vatId: opts.vatId } : {}),
      },
      { action: "settings.tax.update" },
    ),
  );
  await t.model(OWNER, (ctx) =>
    saveRanges(
      ctx,
      {
        ranges: [
          {
            key: "voucherInternal",
            name: "Belege (intern)",
            format: "BE-{YYYY}-{#####}",
            resetPolicy: "yearly",
            next: 1,
          },
        ],
      },
      { year: YEAR, month: Number(TODAY.slice(5, 7)) },
    ),
  );
  const bank = await t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankAccounts",
      {
        kind: "bank",
        name: "Revolut EUR",
        currency: "EUR",
        iban: "DE89370400440532013000",
        accountHolder: "Muster",
        ledgerAccount: chart === "SKR04" ? "1800" : "1200",
        showOnInvoices: true,
        isDefaultForInvoices: true,
        autoApplyMatches: true,
      },
      { action: "settings.bank_account.create" },
    ),
  );
  const supplier = await t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "contacts",
      {
        kind: "organization",
        number: "70000",
        numberNormalized: "70000",
        roles: ["supplier"],
        status: "active",
        organizationName: "Büro Schmidt GmbH",
        displayName: "Büro Schmidt GmbH",
        searchText: "büro schmidt gmbh 70000",
        isConsumer: false,
        isPublicAuthority: false,
        reverseCharge13bCertificates: [],
        einvoice: { preferredFormat: "auto", pdfConsents: [] },
        language: "de",
        currency: "EUR",
        tags: [],
        customFields: {},
        version: 1,
      },
      { action: "contact.create" },
    ),
  );
  return { bank, supplier };
}

let fileCounter = 0;

/** A small valid PDF; `seed` makes the bytes (and the SHA-256) unique unless the same seed is reused. */
export function pdfBytes(seed?: string): Uint8Array {
  const s = seed ?? `file-${fileCounter++}-${Math.random()}`;
  return new TextEncoder().encode(`%PDF-1.4\n1 0 obj <</Type /Page>> endobj\n% ${s}\n%%EOF\n`);
}

type Caller = { action: TestT["action"] };

/** Stores the bytes and runs the real upload action (creates a draft without `voucherId`). */
export async function upload(
  t: TestT,
  caller: Caller,
  opts: { voucherId?: Id<"vouchers">; bytes?: Uint8Array; name?: string; replaceIndex?: number; reason?: string } = {},
): Promise<{ voucherId: Id<"vouchers">; index: number }> {
  const bytes = opts.bytes ?? pdfBytes();
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/pdf" })));
  return caller.action(api.vouchers.attachFile, {
    storageId,
    name: opts.name ?? "rechnung.pdf",
    ...(opts.voucherId ? { voucherId: opts.voucherId } : {}),
    ...(opts.replaceIndex !== undefined ? { replaceIndex: opts.replaceIndex } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
}

/** Standard expense line input (gross mode): 119,00 € @19 % on SKR04 6815 Bürobedarf. */
export const line = (over: Record<string, unknown> = {}) => ({
  account: "6805",
  description: "Telefon und Internet",
  amountCents: 11_900,
  vatRateBp: 1900,
  ...over,
});

/** Header of a complete, bookable expense voucher dated today. */
export const header = (over: Record<string, unknown> = {}) => ({
  supplierName: "Büro Schmidt GmbH",
  supplierVatId: "DE123456789",
  supplierAddress: "Hauptstraße 1, 10115 Berlin",
  documentNumber: `RE-${YEAR}-${Math.floor(Math.random() * 1e6)}`,
  documentDate: TODAY,
  priceMode: "gross" as const,
  lines: [line()],
  ...over,
});
