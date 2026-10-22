/**
 * Self-billing Gutschrift (F04 §4.9, INV-16; UST-11, UST-33). Pure.
 *
 * A Gutschrift (§ 14 Abs. 2 Satz 2 UStG) is issued by us as the recipient of a supply, on behalf of the supplier: it
 * is only allowed under a stored agreement with that supplier valid at the document date. Title always „Gutschrift“,
 * TypeCode 389, own range `GS-`, the note `sb_info`; seller = the supplier, buyer = our company.
 */
import type { CalendarDate } from "../time/calendar-date";
import type { CompanyContext, ContactContext, DocumentContext } from "./draft";
import { billableItems, type DocumentSnapshot, type SnapshotBuyer } from "./snapshot";
import { type Finding, finding } from "./validate/finding";

export interface SelfBillingAgreement {
  readonly agreedOn: string;
  readonly scope: string;
  readonly validFrom: string;
  readonly validTo?: string | undefined;
  /**
   * The supplier is a Kleinunternehmer (§ 19 UStG): the Gutschrift shows no VAT and carries the § 19 note (F04 §4.9
   * step 2). Stored with the agreement because a contact carries no KU flag of its own.
   */
  readonly supplierKleinunternehmer?: boolean | undefined;
  /** The supplier's payout account (BG-17 payee account of the Gutschrift; XRechnung BR-DE-23 needs it). */
  readonly iban?: string | undefined;
}

export const SELF_BILLING_TITLE = "Gutschrift";
export const SELF_BILLING_TYPE_CODE = "389";
export const SELF_BILLING_NOTE_KEY = "sb_info";

/** The agreement covers `date` (validFrom ≤ date ≤ validTo, agreed on or before the date). */
export function agreementValidOn(a: SelfBillingAgreement | undefined | null, date: string): boolean {
  if (!a?.scope.trim()) return false;
  if (a.agreedOn > date || a.validFrom > date) return false;
  return a.validTo === undefined || a.validTo === "" || a.validTo >= date;
}

export const selfBillingAgreementMissingMessage = (supplier: string) =>
  `Mit ${supplier} ist keine gültige Gutschriftsvereinbarung hinterlegt (§ 14 Abs. 2 UStG).`;

/** The supplier block (the seller of a Gutschrift) as far as the Pflichtangaben checks need it. */
export interface SelfBillingSupplier {
  readonly address?:
    | { readonly street: string; readonly postalCode: string; readonly city: string; readonly countryCode: string }
    | undefined;
  readonly taxNumber?: string | undefined;
  readonly vatId?: string | undefined;
  readonly phone?: string | undefined;
  readonly email?: string | undefined;
}

export const SELF_BILLING_MESSAGES = {
  supplierAddress: (name: string) => `Anschrift des Lieferanten ${name} unvollständig → Kontakt bearbeiten.`,
  supplierTaxId: (name: string) =>
    `Steuernummer oder USt-IdNr. des Lieferanten ${name} fehlt (Pflichtangabe der Gutschrift, § 14 Abs. 4 Nr. 2 UStG) → Kontakt bearbeiten.`,
  supplierContact: (name: string) =>
    `Für die E-Rechnung fehlen Telefon und E-Mail des Lieferanten ${name} (Verkäuferkontakt) → Kontakt bearbeiten.`,
  supplierIban: (name: string) =>
    `Für die XRechnung fehlt das Auszahlungskonto (IBAN) des Lieferanten ${name} → Gutschriftsvereinbarung bearbeiten.`,
  foreignSupplier:
    "Gutschriften sind nur für Lieferanten mit Sitz in Deutschland möglich (ausländische Leistungen: Steuerschuldnerschaft des Leistungsempfängers).",
} as const;

/**
 * F04 §5 `self_billing_agreement_missing` (E, UST-33; EC-DOC-103) and the supplier's Pflichtangaben of the Gutschrift
 * (§ 14 Abs. 4 Nr. 1/2 UStG: name, address, tax number or VAT ID — the supplier is the seller).
 */
export function selfBillingFindings(input: {
  type: string;
  documentDate: CalendarDate | string;
  supplierName: string;
  agreement: SelfBillingAgreement | undefined | null;
  /** The swapped seller block (absent in callers that only check the agreement). */
  supplier?: SelfBillingSupplier | undefined;
  /** An e-invoice will be produced (BG-6 seller contact). */
  einvoice?: boolean | undefined;
  /** The XRechnung profile is used (BR-DE-23: credit transfer needs the payee account). */
  xrechnung?: boolean | undefined;
}): Finding[] {
  if (input.type !== "self_billing") return [];
  const name = input.supplierName || "dem Lieferanten";
  const out: Finding[] = [];
  if (!agreementValidOn(input.agreement, input.documentDate)) {
    out.push(
      finding(
        "self_billing_agreement_missing",
        "E",
        "UST-33",
        "pflichtangaben",
        selfBillingAgreementMissingMessage(name),
        { field: "contact/selfBillingAgreement" },
      ),
    );
  }
  const s = input.supplier;
  if (!s) return out;
  const a = s.address;
  if (!a?.street.trim() || !a.postalCode.trim() || !a.city.trim()) {
    out.push(
      finding(
        "self_billing_supplier_address",
        "E",
        "UST-03",
        "pflichtangaben",
        SELF_BILLING_MESSAGES.supplierAddress(name),
        { field: "contact/address" },
      ),
    );
  } else if (a.countryCode !== "DE") {
    // LEGAL-OPEN: F04 §4.9 does not cover foreign suppliers (§ 13b on our side, EU reverse charge in a Gutschrift).
    out.push(
      finding("self_billing_foreign_supplier", "E", "UST-33", "steuern", SELF_BILLING_MESSAGES.foreignSupplier, {
        field: "contact/address",
      }),
    );
  }
  if (!s.taxNumber?.trim() && !s.vatId?.trim()) {
    out.push(
      finding(
        "self_billing_supplier_tax_id",
        "E",
        "UST-04",
        "pflichtangaben",
        SELF_BILLING_MESSAGES.supplierTaxId(name),
        { field: "contact/taxNumber" },
      ),
    );
  }
  if (input.einvoice && (!s.phone?.trim() || !s.email?.trim())) {
    out.push(
      finding(
        "self_billing_supplier_contact",
        "E",
        "ER-10",
        "e_rechnung",
        SELF_BILLING_MESSAGES.supplierContact(name),
        { field: "contact/channels" },
      ),
    );
  }
  if (input.xrechnung && !input.agreement?.iban?.trim()) {
    out.push(
      finding("self_billing_supplier_iban", "E", "ER-10", "e_rechnung", SELF_BILLING_MESSAGES.supplierIban(name), {
        field: "contact/selfBillingAgreement",
      }),
    );
  }
  return out;
}

/** Validates an agreement before it is stored on the supplier contact. */
export function agreementIssues(a: SelfBillingAgreement): string[] {
  const out: string[] = [];
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(a.agreedOn)) out.push("Bitte das Datum der Vereinbarung angeben.");
  if (!iso.test(a.validFrom)) out.push("Bitte angeben, ab wann die Vereinbarung gilt.");
  if (a.validTo && !iso.test(a.validTo)) out.push("Ungültiges Enddatum.");
  if (a.validTo && iso.test(a.validFrom) && a.validTo < a.validFrom) out.push("Das Enddatum liegt vor dem Beginn.");
  if (!a.scope.trim()) out.push("Bitte den Umfang der Vereinbarung beschreiben (z. B. Provisionsabrechnungen).");
  if (a.iban?.trim() && !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalizeIban(a.iban)))
    out.push("Ungültige IBAN des Lieferanten.");
  return out;
}

const normalizeIban = (iban: string) => iban.replace(/\s+/g, "").toUpperCase();

// ── party swap (F04 §4.9 step 2): seller = the supplier, buyer = our company ────────────────────────────────────────

/** Our company as the buyer block (BG-7) of a Gutschrift. */
export function companyAsBuyer(seller: CompanyContext["seller"]): SnapshotBuyer {
  const c = seller.contact;
  return {
    name: seller.name,
    ...(seller.tradeName ? { tradeName: seller.tradeName } : {}),
    address: {
      street: seller.address.street,
      postalCode: seller.address.postalCode,
      city: seller.address.city,
      countryCode: seller.address.countryCode,
      ...(seller.address.poBox ? { poBox: seller.address.poBox } : {}),
    },
    ...(seller.vatId ? { vatId: seller.vatId } : {}),
    ...(seller.taxNumber ? { taxNumber: seller.taxNumber } : {}),
    ...(seller.register ? { registerNumber: `${seller.register.type} ${seller.register.number}`.trim() } : {}),
    ...(seller.electronicAddress ? { electronicAddress: seller.electronicAddress } : {}),
    ...(c.email ? { invoiceEmail: c.email } : {}),
    ...(c.name || c.phone || c.email
      ? {
          contactPerson: {
            ...(c.name ? { name: c.name } : {}),
            ...(c.phone ? { phone: c.phone } : {}),
            ...(c.email ? { email: c.email } : {}),
          },
        }
      : {}),
    isConsumer: false,
    isPublicAuthority: false,
  };
}

/**
 * The supplier contact as the seller block (BG-4). A contact carries no legal form: `other` (no Geschäftsbrief
 * footer is printed for the supplier — the letter's footer is ours, see `selfBilling.issuer`).
 */
function supplierAsSeller(c: ContactContext): CompanyContext["seller"] {
  const b = c.buyer;
  const email = b.invoiceEmail ?? b.contactPerson?.email ?? "";
  const electronicAddress = b.electronicAddress ?? (email ? { scheme: "EM" as const, value: email } : undefined);
  return {
    legalForm: "other",
    name: b.name,
    ...(b.tradeName ? { tradeName: b.tradeName } : {}),
    address: {
      street: b.address?.street ?? "",
      postalCode: b.address?.postalCode ?? "",
      city: b.address?.city ?? "",
      countryCode: b.address?.countryCode ?? c.countryCode,
      ...(b.address?.poBox ? { poBox: b.address.poBox } : {}),
    },
    contact: { name: b.contactPerson?.name ?? b.name, phone: b.contactPerson?.phone ?? c.phone ?? "", email },
    representatives: [],
    ...(b.taxNumber ? { taxNumber: b.taxNumber } : {}),
    ...(b.vatId ? { vatId: b.vatId } : {}),
    ...(electronicAddress ? { electronicAddress } : {}),
  };
}

/**
 * F04 §4.9 / INV-16: the context of a self-billing draft with the parties swapped, so the unchanged P1 pipeline
 * (resolution, validation, snapshot, XML) treats the supplier as the seller and our company as the buyer:
 *  - VAT follows the supplier (KU flag of the agreement), never our own KU status;
 *  - ER-03 sees the supplier as issuer with unknown prior-year turnover (→ `MUST_E` from 2027, step 3);
 *  - our company becomes the buyer; only the Geschäftsbrief items of our letter stay as company checks;
 *  - our bank account is not the payee (the supplier is paid), our KU/OSS/duplicate figures do not apply.
 * Other types are returned unchanged.
 */
export function selfBillingContext(type: string, ctx: DocumentContext): DocumentContext {
  if (type !== "self_billing" || !ctx.contact) return ctx;
  const supplier = ctx.contact;
  const issuer = ctx.company.seller;
  const { bankAccount: _bank, kuYearTurnoverCents: _ku, ossTurnover: _oss, chart: _chart, ...rest } = ctx;
  return {
    ...rest,
    company: {
      ...ctx.company,
      seller: supplierAsSeller(supplier),
      validation: {
        // Our own letter (sender, footer) still needs the Geschäftsbrief items and our address as the buyer's.
        blocking: ctx.company.validation.blocking.filter(
          (i) => i.code !== "tax_id_missing" && i.code !== "contact_missing",
        ),
        warnings: ctx.company.validation.warnings,
      },
      kleinunternehmer: [
        { validFrom: "1900-01-01", isKU: supplier.selfBillingAgreement?.supplierKleinunternehmer === true },
      ],
      taxationMethod: [{ validFrom: "1900-01-01", method: "soll" }],
      priorYearTurnover: [],
      foundedOn: undefined,
      paymentReferencePrefix: undefined,
    },
    contact: {
      id: supplier.id,
      buyer: companyAsBuyer(issuer),
      countryCode: issuer.address.countryCode,
      isConsumer: false,
      isPublicAuthority: false,
      ...(issuer.vatId ? { vatId: issuer.vatId } : {}),
      vatChecks: [],
      preferredFormat: supplier.preferredFormat,
      // The Gutschrift is sent to the supplier: their consent to a PDF counts (ER-03).
      pdfConsents: supplier.pdfConsents,
      certificates13b: [],
      ...(supplier.selfBillingAgreement ? { selfBillingAgreement: supplier.selfBillingAgreement } : {}),
      ...(supplier.archived ? { archived: true } : {}),
    },
    recentInvoices: [],
    // The supplier is paid (BG-17 = their account), never our own bank account.
    ...(supplier.selfBillingAgreement?.iban?.trim()
      ? { bankAccount: { iban: normalizeIban(supplier.selfBillingAgreement.iban), accountHolder: supplier.buyer.name } }
      : {}),
    selfBilling: { issuer, supplierName: supplier.buyer.name },
  };
}

// ── purchase voucher (F04 §4.9 step 4) ──────────────────────────────────────────────────────────────────────────────

/** The voucher draft input (F06 VOU-001 shape) a finalised Gutschrift is recorded as. */
export interface SelfBillingVoucherInput {
  readonly direction: "expense";
  readonly supplierName: string;
  readonly supplierVatId?: string;
  readonly supplierTaxNumber?: string;
  readonly supplierAddress: string;
  readonly documentNumber: string;
  readonly documentDate: string;
  readonly supplyDate?: DocumentSnapshot["supplyDate"];
  readonly currency: string;
  readonly priceMode: "net";
  readonly lines: {
    readonly account: string;
    readonly description: string;
    readonly amountCents: number;
    readonly vatRateBp: number;
    readonly vatCents: number;
  }[];
  readonly statedTotals: { readonly grossCents: number };
}

/**
 * One net line per VAT group of the Gutschrift (base and VAT exactly as in the snapshot, so the stated total
 * reconciles to the cent); the expense account is the role `expense.services` (Fremdleistungen) resolved by the
 * caller — the owner can recategorise the voucher (VOU-008). Our input-VAT deduction follows our own KU status in F06.
 */
export function selfBillingVoucherInput(s: DocumentSnapshot, account: string): SelfBillingVoucherInput {
  const a = s.seller.address;
  const subject = billableItems(s)[0]?.name;
  return {
    direction: "expense",
    supplierName: s.seller.name,
    ...(s.seller.vatId ? { supplierVatId: s.seller.vatId } : {}),
    ...(s.seller.taxNumber ? { supplierTaxNumber: s.seller.taxNumber } : {}),
    supplierAddress: [a.street, `${a.postalCode} ${a.city}`.trim()].filter(Boolean).join(", "),
    documentNumber: s.number,
    documentDate: s.documentDate,
    ...(s.supplyDate ? { supplyDate: s.supplyDate } : {}),
    currency: s.currency,
    priceMode: "net",
    lines: s.totals.byGroup.map((g) => ({
      account,
      description: `${SELF_BILLING_TITLE} ${s.number}${subject ? ` – ${subject}` : ""}`,
      amountCents: g.baseCents,
      vatRateBp: g.category === "KU" ? 0 : g.rateBp,
      vatCents: g.vatCents,
    })),
    statedTotals: { grossCents: s.totals.grossCents },
  };
}

export const OBJECTION_MESSAGES = {
  type: "Ein Widerspruch kann nur zu einer Gutschrift erfasst werden.",
  status: "Ein Widerspruch ist nur bei einer fertiggestellten, nicht stornierten Gutschrift möglich.",
  date: "Das Datum des Widerspruchs darf nicht vor der Gutschrift und nicht in der Zukunft liegen.",
  text: "Bitte den Inhalt des Widerspruchs angeben.",
} as const;

/** F04 §4.2.8 / INV-16: a Widerspruch (date, text) on a finalised or sent Gutschrift. */
export function objectionIssue(input: {
  type: string;
  status: string;
  documentDate: string;
  date: string;
  text: string;
  today: string;
}): string | null {
  if (input.type !== "self_billing") return OBJECTION_MESSAGES.type;
  if (input.status !== "finalized" && input.status !== "sent") return OBJECTION_MESSAGES.status;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || input.date < input.documentDate || input.date > input.today)
    return OBJECTION_MESSAGES.date;
  if (!input.text.trim()) return OBJECTION_MESSAGES.text;
  return null;
}
