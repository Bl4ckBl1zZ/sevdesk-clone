/**
 * Geschäftsbrief footer (F01 SET-013, §5.2 "Printed in footer", MAIL-03). Pure: the same three columns appear in the
 * live preview on the settings page / wizard step 6, the layout preview (SET-073) and — from P1 — every rendered
 * document. The footer cannot be switched off (SET-014, ../documents/layout.ts).
 *
 *   1  company and contact      2  register, representatives, capital, tax IDs      3  bank accounts
 */
import { friendlyFormatIBAN } from "ibantools";
import { formatEuro } from "../money/format";
import { isBundesland, normalizeTaxNumber } from "../tax/tax-number";
import { fieldsFor, footerDelta, type LegalForm } from "./legal-forms";

export interface FooterCompany {
  legalForm: LegalForm;
  name: string;
  tradeName?: string;
  address: { street: string; postalCode: string; city: string; countryCode: string; poBox?: string };
  seat?: string;
  contact: { name: string; phone: string; email: string; website?: string };
  register?: { court: string; type: string; number: string };
  representatives: readonly { name: string; role?: "chair" }[];
  generalPartner?: {
    name: string;
    seat: string;
    registerCourt: string;
    registerNumber: string;
    managingDirectors: readonly string[];
  };
  supervisoryBoardChair?: string;
  shareCapital?: { amountCents: number; outstandingCents?: number };
  /** ELSTER 13-digit form (stored) or the regional form. */
  taxNumber?: string;
  taxNumberState?: string;
  vatId?: string;
}

export interface FooterAccount {
  name?: string;
  iban?: string;
  bic?: string;
  bankName?: string;
  accountHolder: string;
}

export interface GeschaeftsbriefFooter {
  columns: [string[], string[], string[]];
}

/** One entry of the labelled footer („IBAN LT13…“); address lines have no label. */
export interface FooterField {
  readonly label?: string;
  readonly value: string;
  /** The value goes on its own line under the label. */
  readonly stacked?: boolean;
}

const REPRESENTATIVE_LABEL: Record<string, string> = {
  representatives: "Geschäftsführer",
  representativesAg: "Vorstand",
  representativesPartners: "Gesellschafter",
  representativesPartg: "Partner",
};

const CAPITAL_LABEL: Partial<Record<LegalForm, string>> = { ag: "Grundkapital" };

const regionNames = new Intl.DisplayNames(["de"], { type: "region" });

function taxNumberDisplay(taxNumber: string, state: string | undefined): string {
  const n = normalizeTaxNumber(taxNumber, state && isBundesland(state) ? state : undefined);
  return n.ok ? n.value.display : taxNumber;
}

const iban = (value: string) => friendlyFormatIBAN(value) ?? value;

function companyColumn(c: FooterCompany): string[] {
  const out = [c.name];
  if (c.tradeName) out.push(c.tradeName);
  if (c.address.street) out.push(c.address.street);
  else if (c.address.poBox) out.push(c.address.poBox);
  out.push([c.address.postalCode, c.address.city].filter(Boolean).join(" "));
  if (c.address.countryCode && c.address.countryCode !== "DE") {
    out.push(regionNames.of(c.address.countryCode) ?? c.address.countryCode);
  }
  if (c.contact.phone) out.push(`Tel. ${c.contact.phone}`);
  if (c.contact.email) out.push(c.contact.email);
  if (c.contact.website) out.push(c.contact.website);
  return out.filter((l) => l.trim() !== "");
}

function legalColumn(c: FooterCompany): string[] {
  const f = fieldsFor(c.legalForm);
  const out: string[] = [];
  const seat = c.seat || c.address.city;
  if (f.seat && seat) out.push(`Sitz: ${seat}`);
  if (f.register && c.register && (c.register.court || c.register.number)) {
    if (c.register.court) out.push(`Registergericht: ${c.register.court}`);
    if (c.register.number) out.push(`${c.register.type || f.register} ${c.register.number}`);
  }
  if (f.generalPartner && c.generalPartner) {
    const gp = c.generalPartner;
    const gpRegister = [gp.registerCourt, gp.registerNumber].filter(Boolean).join(" ");
    out.push(
      `Persönlich haftende Gesellschafterin: ${[gp.name, gp.seat ? `Sitz ${gp.seat}` : "", gpRegister].filter(Boolean).join(", ")}`,
    );
    if (gp.managingDirectors.length) out.push(`Geschäftsführer der Komplementärin: ${gp.managingDirectors.join(", ")}`);
  }
  const reps = c.representatives.filter((r) => r.name.trim() !== "");
  if (f.representatives && reps.length) {
    const label = REPRESENTATIVE_LABEL[f.representatives.label] ?? "Vertreten durch";
    out.push(`${label}: ${reps.map((r) => (r.role === "chair" ? `${r.name} (Vorsitz)` : r.name)).join(", ")}`);
  }
  if (c.supervisoryBoardChair) out.push(`Vorsitz des Aufsichtsrats: ${c.supervisoryBoardChair}`);
  if (c.shareCapital && c.shareCapital.amountCents > 0) {
    const outstanding = c.shareCapital.outstandingCents
      ? ` (ausstehende Einlagen: ${formatEuro(c.shareCapital.outstandingCents)})`
      : "";
    out.push(
      `${CAPITAL_LABEL[c.legalForm] ?? "Stammkapital"}: ${formatEuro(c.shareCapital.amountCents)}${outstanding}`,
    );
  }
  if (c.taxNumber) out.push(`Steuernummer: ${taxNumberDisplay(c.taxNumber, c.taxNumberState)}`);
  if (c.vatId) out.push(`USt-IdNr.: ${c.vatId}`);
  return out;
}

function bankColumn(c: FooterCompany, accounts: readonly FooterAccount[], all: boolean): string[] {
  const printable = accounts.filter((a) => a.iban);
  const [first, ...rest] = printable;
  if (!first?.iban) return [];
  const out = [`IBAN: ${iban(first.iban)}`];
  if (first.bic) out.push(`BIC: ${first.bic}`);
  if (first.accountHolder && first.accountHolder !== c.name) out.push(`Kontoinhaber: ${first.accountHolder}`);
  if (all) for (const a of rest) out.push(`${a.name ?? "Konto"}: IBAN ${iban(a.iban ?? "")}`);
  return out;
}

/**
 * The footer for `company`. `accounts`: the invoice accounts, default first (SET-051); with the layout option
 * „alle Rechnungskonten im Fuß“ every account is listed.
 */
export function geschaeftsbriefFooter(
  company: FooterCompany,
  accounts: readonly FooterAccount[],
  opts: { allInvoiceAccounts?: boolean } = {},
): GeschaeftsbriefFooter {
  return {
    columns: [
      companyColumn(company),
      legalColumn(company),
      bankColumn(company, accounts, opts.allInvoiceAccounts ?? false),
    ],
  };
}

const SHORT_LABEL: Readonly<Record<string, string>> = { "USt-IdNr.": "USt.-ID", Steuernummer: "Steuer-Nr." };

/** A `legalColumn` line as label and value; the short labels of the layout replace the long ones. */
function legalField(line: string): FooterField {
  const i = line.indexOf(": ");
  if (i < 0) return { value: line };
  const label = line.slice(0, i);
  return { label: SHORT_LABEL[label] ?? label, value: line.slice(i + 2) };
}

/**
 * The same Geschäftsbrief items as `geschaeftsbriefFooter` (MAIL-03) in the four labelled columns of the layout
 * `sevdesk` (F01 SET-071): address · contact · tax IDs, register and representatives · bank. The legal lines come from
 * `legalColumn`, so no legal form can lose an item here.
 */
export function labelledGeschaeftsbriefFooter(
  c: FooterCompany,
  accounts: readonly FooterAccount[],
  opts: { allInvoiceAccounts?: boolean } = {},
): FooterField[][] {
  const address = [
    c.name,
    c.tradeName,
    c.address.street || c.address.poBox,
    [c.address.postalCode, c.address.city].filter(Boolean).join(" "),
    c.address.countryCode ? (regionNames.of(c.address.countryCode) ?? c.address.countryCode) : undefined,
  ].flatMap((value) => (value?.trim() ? [{ value }] : []));
  const contact = [
    { label: "Tel.", value: c.contact.phone },
    { label: "E-Mail", value: c.contact.email },
    { label: "Web", value: c.contact.website ?? "" },
  ].filter((f) => f.value.trim() !== "");
  const legal = legalColumn(c).map(legalField);
  const taxIds = legal.filter((f) => f.label === "USt.-ID").concat(legal.filter((f) => f.label === "Steuer-Nr."));
  const rest = legal.filter((f) => !taxIds.includes(f));
  const owner = c.legalForm === "einzelunternehmen" ? [{ label: "Inhaber/-in", value: c.name, stacked: true }] : [];
  const [first, ...others] = accounts.filter((a) => a.iban);
  const bank: FooterField[] = first?.iban
    ? [
        ...(first.bankName ? [{ label: "Bank", value: first.bankName }] : []),
        { label: "IBAN", value: first.iban },
        ...(first.bic ? [{ label: "BIC", value: first.bic }] : []),
        ...(first.accountHolder && first.accountHolder !== c.name
          ? [{ label: "Kontoinhaber", value: first.accountHolder }]
          : []),
        ...(opts.allInvoiceAccounts ? others.map((a) => ({ label: a.name ?? "Konto", value: a.iban ?? "" })) : []),
      ]
    : [];
  return [address, contact, [...taxIds, ...rest, ...owner], bank];
}

/** „Pflichtangaben im Fußtext: + Registergericht, + HRB, + Geschäftsführer" when the legal form changes. */
export function footerDeltaMessage(from: string | undefined, to: string | undefined): string | null {
  const delta = footerDelta(from, to);
  return delta.length ? `Pflichtangaben im Fußtext: ${delta.map((d) => `+ ${d}`).join(", ")}` : null;
}
