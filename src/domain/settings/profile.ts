/**
 * Company profile ↔ settings forms (F01 SET-010…044, 03 §1 `companyProfile`). Pure mapping used by the Convex
 * model (save) and the settings queries (load); the forms themselves are the zod schemas in ../schemas/settings.
 *
 * The singleton is created on the first settings save of the wizard with neutral defaults (SET-003 "partial
 * profile allowed"): empty strings mean "not entered yet"; completeness is derived, never stored.
 */

import type { FooterCompany } from "../company/footer";
import type { LegalForm } from "../company/legal-forms";
import type { CompanyForValidation } from "../company/validate";
import { checkDatevKeyChange } from "../datev/keys";
import { formatCents } from "../money/format";
import { type Issue, issue } from "../result";
import {
  type CompanyValues,
  datevKeysFromForm,
  parseTurnoverCents,
  type TaxFormValues,
  type TaxValues,
} from "../schemas/settings";
import { checkKuHistoryChange, type FinalisedDocRef } from "../tax/ku-history";
import { isBundesland, normalizeTaxNumber } from "../tax/tax-number";
import type { CalendarDate } from "../time/calendar-date";

export interface PostalAddressData {
  name: string;
  street: string;
  street2?: string;
  postalCode: string;
  city: string;
  countryCode: string;
  poBox?: string;
}

/** The fields of 03 `companyProfile` the settings forms read and write. */
export interface CompanySettingsData {
  legalForm: LegalForm;
  name: string;
  tradeName?: string;
  address: PostalAddressData;
  seat?: string;
  contact: { name: string; phone: string; email: string; website?: string };
  register?: { court: string; type: "HRA" | "HRB" | "PR" | "GnR" | "VR" | "GsR"; number: string };
  representatives: { name: string; role?: "chair" }[];
  generalPartner?: {
    name: string;
    seat: string;
    registerCourt: string;
    registerNumber: string;
    managingDirectors: string[];
  };
  hasSupervisoryBoard?: boolean;
  supervisoryBoardChair?: string;
  noNaturalPersonLiable?: boolean;
  electronicAddress: { scheme: "EM" | "0204" | "9930"; value: string };
}

export interface TaxSettingsData {
  taxNumber?: string;
  taxNumberState?: string;
  vatId?: string;
  kleinunternehmer: { validFrom: string; isKU: boolean; waiverDate?: string }[];
  taxationMethod: {
    validFrom: string;
    method: "soll" | "ist";
    financeOfficeApproval?: { date: string; reference: string };
  }[];
  ustvaPeriod: { year: number; period: "monthly" | "quarterly" | "annual_only"; dauerfrist: boolean }[];
  profitMethod: { validFromFiscalYear: number; method: "euer" | "bilanz" }[];
  euerExemptionConfirmedAt?: number;
  chartOfAccounts: { validFromFiscalYear: number; chart: "SKR03" | "SKR04"; accountMappingStorageId?: unknown }[];
  fiscalYearStartMonth: number;
  foundedOn?: string;
  priorYearTotalTurnoverCents: { year: number; amountCents: number }[];
  datev?: {
    consultantNumber?: number;
    clientNumber?: number;
    accountLength: number;
    formatVersion?: 12 | 13;
    personalAccounts: boolean;
    collectiveDebtorAccount?: string;
  };
}

export type ProfileData = CompanySettingsData &
  TaxSettingsData & {
    serverLocation: { countryCode: string; provider?: string; confirmedAt: number };
    accessConcept: { baseDomain: string; network: "tailnet"; tailnetName?: string; confirmedAt: number };
    setupCompletedAt?: number;
  };

const opt = <K extends string, V>(key: K, value: V | undefined | "") =>
  (value === undefined || value === "" ? {} : { [key]: value }) as Partial<Record<K, V>>;

// ── defaults for a new singleton (03 §1; SET-019 document defaults) ─────────────────────────────────────
export function newCompanyProfile() {
  return {
    legalForm: "einzelunternehmen",
    name: "",
    address: { name: "", street: "", postalCode: "", city: "", countryCode: "DE" },
    contact: { name: "", phone: "", email: "" },
    representatives: [],
    kleinunternehmer: [],
    taxationMethod: [],
    ustvaPeriod: [],
    profitMethod: [],
    chartOfAccounts: [],
    fiscalYearStartMonth: 1,
    priorYearTotalTurnoverCents: [],
    electronicAddress: { scheme: "EM", value: "" },
    datev: { accountLength: 4, personalAccounts: true },
    serverLocation: { countryCode: "", confirmedAt: 0 },
    accessConcept: { baseDomain: "", network: "tailnet", confirmedAt: 0 },
    defaults: {
      paymentTerms: { dueDays: 14 },
      priceMode: "net",
      language: "de",
      backdateWindowDays: 10,
      quoteValidityDays: 30,
      quoteRevisionNumbering: "suffix",
      catchUpAutoMax: 3,
      fxRateSource: "bmf_monthly",
      discountOnCustomerPrices: false,
      stockOnInvoiceWithoutDeliveryNote: false,
      preventNegativeStock: false,
      standardAttachments: [],
    },
    receivables: {
      agingBucketEdgesDays: [30, 60, 90],
      postalDeliveryDays: 3,
      autoFinalizeReminders: false,
      bankDataMaxAgeDays: 7,
      defaultStartViaReminder: "after_printed_deadline",
      reopenGraceDays: 7,
      allocationOrder: "principal_first",
    },
    matching: { autoApplyBp: 9800, safeBp: 9500, suggestBp: 4000 },
    assetPolicy: [],
    version: 0,
  } satisfies ProfileData & Record<string, unknown>;
}

// ── company form ────────────────────────────────────────────────────────────────────────────────────────
export function companyPatchFromForm(v: CompanyValues, current?: Pick<CompanySettingsData, "electronicAddress">) {
  const register = (() => {
    const type = registerTypeFor(v.legalForm);
    return type && (v.registerCourt || v.registerNumber)
      ? { court: v.registerCourt, type, number: v.registerNumber }
      : undefined;
  })();
  const gpNeeded =
    v.legalForm === "gmbh_co_kg" || ((v.legalForm === "ohg" || v.legalForm === "kg") && v.noNaturalPersonLiable);
  const generalPartner =
    gpNeeded && v.generalPartnerName
      ? {
          name: v.generalPartnerName,
          seat: v.generalPartnerSeat,
          registerCourt: v.generalPartnerRegisterCourt,
          registerNumber: v.generalPartnerRegisterNumber,
          managingDirectors: v.generalPartnerManagingDirectors
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : undefined;
  // SET-017: BT-34 defaults to EM + contact e-mail; a deliberately chosen 9930/0204 scheme is kept.
  const electronicAddress =
    current && current.electronicAddress.scheme !== "EM"
      ? current.electronicAddress
      : { scheme: "EM" as const, value: v.email };
  return {
    legalForm: v.legalForm,
    name: v.name,
    tradeName: v.tradeName || undefined,
    address: {
      name: v.name,
      street: v.street,
      postalCode: v.postalCode,
      city: v.city,
      countryCode: v.countryCode,
      ...opt("poBox", v.poBox),
    },
    seat: v.seat || undefined,
    contact: { name: v.contactName, phone: v.phone, email: v.email, ...opt("website", v.website) },
    register,
    representatives: v.representatives.map((r) => ({
      name: r.name,
      ...(v.legalForm === "ag" && r.chair ? { role: "chair" as const } : {}),
    })),
    generalPartner,
    hasSupervisoryBoard: v.hasSupervisoryBoard,
    supervisoryBoardChair: v.supervisoryBoardChair || undefined,
    noNaturalPersonLiable: v.legalForm === "ohg" || v.legalForm === "kg" ? v.noNaturalPersonLiable : undefined,
    electronicAddress,
  } satisfies Partial<CompanySettingsData> & Record<string, unknown>;
}

function registerTypeFor(legalForm: LegalForm): "HRA" | "HRB" | "PR" | "GsR" | undefined {
  switch (legalForm) {
    case "ek":
    case "ohg":
    case "kg":
    case "gmbh_co_kg":
      return "HRA";
    case "gmbh":
    case "ug":
    case "ag":
      return "HRB";
    case "partg":
      return "PR";
    case "egbr":
      return "GsR";
    default:
      return undefined;
  }
}

/** Form values of the stored profile, or undefined while the company step has not been saved. */
export function companyFormFromProfile(p: CompanySettingsData): CompanyValues | undefined {
  if (!p.name) return undefined;
  return {
    legalForm: p.legalForm,
    name: p.name,
    tradeName: p.tradeName ?? "",
    street: p.address.street,
    poBox: p.address.poBox ?? "",
    postalCode: p.address.postalCode,
    city: p.address.city,
    countryCode: p.address.countryCode,
    seat: p.seat ?? "",
    contactName: p.contact.name,
    phone: p.contact.phone,
    email: p.contact.email,
    website: p.contact.website ?? "",
    registerCourt: p.register?.court ?? "",
    registerNumber: p.register?.number ?? "",
    representatives: p.representatives.map((r) => ({ name: r.name, ...(r.role === "chair" ? { chair: true } : {}) })),
    hasSupervisoryBoard: p.hasSupervisoryBoard ?? false,
    supervisoryBoardChair: p.supervisoryBoardChair ?? "",
    noNaturalPersonLiable: p.noNaturalPersonLiable ?? false,
    generalPartnerName: p.generalPartner?.name ?? "",
    generalPartnerSeat: p.generalPartner?.seat ?? "",
    generalPartnerRegisterCourt: p.generalPartner?.registerCourt ?? "",
    generalPartnerRegisterNumber: p.generalPartner?.registerNumber ?? "",
    generalPartnerManagingDirectors: p.generalPartner?.managingDirectors.join(", ") ?? "",
  };
}

// ── tax form ────────────────────────────────────────────────────────────────────────────────────────────
export interface TaxPatchContext {
  /** Business date of the save (Europe/Berlin). */
  today: CalendarDate;
  now: number;
  /** SET-034: finalised documents with the supply date their KU status was resolved by (P1; empty before). */
  finalisedDocuments?: readonly FinalisedDocRef[];
  /** SET-E22: number of DATEV exports so far (locks the account length). */
  datevExportCount?: number;
  /** SET-041/042 (F08 ACC-007): fiscal years that already have journal entries. */
  journalFiscalYears?: readonly number[];
}

/** Appends a date-effective entry when the status on `validFrom` differs; replaces an entry with the same date. */
function upsertEffective<E extends { validFrom: string }>(list: readonly E[], entry: E, same: (a: E) => boolean): E[] {
  const sorted = [...list].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  const current = [...sorted].reverse().find((e) => e.validFrom <= entry.validFrom);
  if (current && same(current)) return sorted;
  return [...sorted.filter((e) => e.validFrom !== entry.validFrom), entry].sort((a, b) =>
    a.validFrom.localeCompare(b.validFrom),
  );
}

/**
 * Tax form → profile fields. The form edits the status for the current year; history rows are appended
 * (date-effective, SET-032/037/038) instead of rewritten. Waiver locks and retroactive entries that touch
 * finalised documents (SET-033/034) are enforced with the document history (P1).
 */
export function taxPatchFromForm(
  v: TaxValues,
  current: TaxSettingsData,
  ctx: TaxPatchContext,
): { ok: true; patch: TaxSettingsData } | { ok: false; error: Issue } {
  const year = Number(ctx.today.slice(0, 4));
  let taxNumber: string | undefined;
  let taxNumberState: string | undefined;
  if (v.taxNumber) {
    const n = normalizeTaxNumber(v.taxNumber, isBundesland(v.taxNumberState) ? v.taxNumberState : undefined);
    if (!n.ok) return { ok: false, error: n.error };
    taxNumber = n.value.elster;
    taxNumberState = n.value.state;
  }
  const turnover = parseTurnoverCents(v.priorYearTurnover);
  if (turnover === null)
    return { ok: false, error: issue("amount_invalid", "Bitte einen Betrag wie 24.500,00 eingeben.") };

  const kuFrom = v.isKleinunternehmer === "yes" ? v.kuValidFrom : `${year}-01-01`;
  const kleinunternehmer =
    v.isKleinunternehmer === "no" && current.kleinunternehmer.length === 0
      ? [] // never KU: regular taxation is the default without an entry
      : upsertEffective(
          current.kleinunternehmer,
          {
            validFrom: kuFrom,
            isKU: v.isKleinunternehmer === "yes",
            ...(v.isKleinunternehmer === "no" && v.kuWaiverDate ? { waiverDate: v.kuWaiverDate } : {}),
          },
          (e) =>
            e.isKU === (v.isKleinunternehmer === "yes") &&
            (v.isKleinunternehmer === "yes" || !v.kuWaiverDate || e.waiverDate === v.kuWaiverDate),
        );

  const kuCheck = checkKuHistoryChange(
    current.kleinunternehmer,
    kleinunternehmer,
    ctx.finalisedDocuments ?? [],
    v.kuReason,
  );
  if (!kuCheck.ok) return { ok: false, error: kuCheck.error };

  const datevBefore = current.datev ?? { accountLength: 4, personalAccounts: true };
  const datevKeys = datevKeysFromForm(v);
  const datevCheck = checkDatevKeyChange(datevBefore, datevKeys, ctx.datevExportCount ?? 0);
  if (!datevCheck.ok) return { ok: false, error: datevCheck.error };
  const { consultantNumber: _c, clientNumber: _n, ...datevRest } = datevBefore;
  const datev = {
    ...datevRest,
    accountLength: datevKeys.accountLength,
    ...(datevKeys.consultantNumber !== undefined ? { consultantNumber: datevKeys.consultantNumber } : {}),
    ...(datevKeys.clientNumber !== undefined ? { clientNumber: datevKeys.clientNumber } : {}),
  };

  const taxationMethod = upsertEffective(
    current.taxationMethod,
    { validFrom: `${year}-01-01`, method: v.taxationMethod },
    (e) => e.method === v.taxationMethod,
  );

  const ustvaPeriod = [
    ...current.ustvaPeriod.filter((p) => p.year !== year),
    {
      year,
      period: v.isKleinunternehmer === "yes" ? ("annual_only" as const) : v.ustvaPeriod,
      dauerfrist: v.isKleinunternehmer === "yes" ? false : v.dauerfrist,
    },
  ].sort((a, b) => a.year - b.year);

  // Free to change until the first journal entry exists (SET-039/041 lock arrives with F08, P1).
  const profitMethod = [
    ...current.profitMethod.filter((p) => p.validFromFiscalYear !== year),
    { validFromFiscalYear: year, method: v.profitMethod },
  ].sort((a, b) => a.validFromFiscalYear - b.validFromFiscalYear);
  const chartOfAccounts = [
    ...current.chartOfAccounts.filter((c) => c.validFromFiscalYear !== year),
    { validFromFiscalYear: year, chart: v.chartOfAccounts },
  ].sort((a, b) => a.validFromFiscalYear - b.validFromFiscalYear);

  // SET-041 / F08 ACC-007 (E-ACC-09, EC-116): once a fiscal year has journal entries its chart is fixed; the
  // switch with an account mapping table effective at the next fiscal year start follows in P3.
  const booked = ctx.journalFiscalYears ?? [];
  const effectiveChart = latest(current.chartOfAccounts, (c) => c.validFromFiscalYear, year)?.chart ?? "SKR03";
  if (booked.includes(year) && effectiveChart !== v.chartOfAccounts) {
    return {
      ok: false,
      error: issue(
        "CHART_LOCKED",
        "Der Kontenrahmen kann erst zum Beginn des nächsten Wirtschaftsjahres gewechselt werden.",
      ),
    };
  }
  // SET-042: the fiscal year start is locked after the first journal entry.
  if (booked.length > 0 && v.fiscalYearStartMonth !== current.fiscalYearStartMonth) {
    return {
      ok: false,
      error: issue(
        "FISCAL_YEAR_LOCKED",
        "Das Wirtschaftsjahr kann nach der ersten Buchung nicht mehr geändert werden.",
      ),
    };
  }

  const priorYear = year - 1;
  const priorYearTotalTurnoverCents = [
    ...current.priorYearTotalTurnoverCents.filter((t) => t.year !== priorYear),
    ...(turnover === undefined ? [] : [{ year: priorYear, amountCents: turnover }]),
  ].sort((a, b) => a.year - b.year);

  return {
    ok: true,
    patch: {
      ...(taxNumber ? { taxNumber, taxNumberState } : {}),
      ...(v.vatId ? { vatId: v.vatId } : {}),
      kleinunternehmer,
      taxationMethod,
      ustvaPeriod,
      profitMethod,
      ...(v.profitMethod === "euer" && v.euerConfirmed
        ? { euerExemptionConfirmedAt: current.euerExemptionConfirmedAt ?? ctx.now }
        : {}),
      chartOfAccounts,
      fiscalYearStartMonth: v.fiscalYearStartMonth,
      ...(v.foundedOn ? { foundedOn: v.foundedOn } : {}),
      priorYearTotalTurnoverCents,
      datev,
    },
  };
}

const latest = <E>(list: readonly E[], key: (e: E) => string | number, upTo: string | number): E | undefined =>
  [...list]
    .filter((e) => key(e) <= upTo)
    .sort((a, b) => (key(a) < key(b) ? -1 : 1))
    .at(-1);

/** Form values for the tax step, or undefined while no tax data exist. */
export function taxFormFromProfile(
  p: TaxSettingsData & { legalForm: LegalForm },
  today: CalendarDate,
): TaxFormValues | undefined {
  if (!p.taxNumber && !p.vatId && p.chartOfAccounts.length === 0) return undefined;
  const year = Number(today.slice(0, 4));
  const ku = latest(p.kleinunternehmer, (e) => e.validFrom, today);
  const method = latest(p.taxationMethod, (e) => e.validFrom, today);
  const period = p.ustvaPeriod.find((e) => e.year === year);
  const profit = latest(p.profitMethod, (e) => e.validFromFiscalYear, year);
  const chart = latest(p.chartOfAccounts, (e) => e.validFromFiscalYear, year);
  const turnover = p.priorYearTotalTurnoverCents.find((t) => t.year === year - 1);
  const display =
    p.taxNumber && isBundesland(p.taxNumberState ?? "")
      ? normalizeTaxNumber(p.taxNumber, p.taxNumberState as never)
      : undefined;
  return {
    legalForm: p.legalForm,
    taxNumberState: p.taxNumberState ?? "",
    taxNumber: display?.ok ? display.value.display : (p.taxNumber ?? ""),
    vatId: p.vatId ?? "",
    isKleinunternehmer: ku?.isKU ? "yes" : "no",
    kuValidFrom: ku?.isKU ? ku.validFrom : "",
    kuWaiverDate: !ku?.isKU && ku?.waiverDate ? ku.waiverDate : "",
    taxationMethod: method?.method ?? "soll",
    istConfirmed: method?.method === "ist",
    ustvaPeriod: period?.period ?? "quarterly",
    dauerfrist: period?.dauerfrist ?? false,
    profitMethod: profit?.method ?? "euer",
    euerConfirmed: p.euerExemptionConfirmedAt !== undefined,
    chartOfAccounts: chart?.chart ?? "SKR03",
    fiscalYearStartMonth: p.fiscalYearStartMonth,
    foundedOn: p.foundedOn ?? "",
    priorYearTurnover: turnover ? formatCents(turnover.amountCents) : "",
    datevConsultantNumber: p.datev?.consultantNumber !== undefined ? String(p.datev.consultantNumber) : "",
    datevClientNumber: p.datev?.clientNumber !== undefined ? String(p.datev.clientNumber) : "",
    datevAccountLength: p.datev?.accountLength ?? 4,
  };
}

/** The profile as input for `validateCompanyForDocuments`. */
export function companyForValidation(p: ProfileData): CompanyForValidation {
  return {
    legalForm: p.legalForm,
    name: p.name,
    address: p.address,
    ...opt("seat", p.seat),
    contact: p.contact,
    ...(p.register ? { register: p.register } : {}),
    representatives: p.representatives,
    ...(p.generalPartner ? { generalPartner: p.generalPartner } : {}),
    ...(p.hasSupervisoryBoard !== undefined ? { hasSupervisoryBoard: p.hasSupervisoryBoard } : {}),
    ...opt("supervisoryBoardChair", p.supervisoryBoardChair),
    ...(p.noNaturalPersonLiable !== undefined ? { noNaturalPersonLiable: p.noNaturalPersonLiable } : {}),
    ...opt("taxNumber", p.taxNumber),
    ...opt("vatId", p.vatId),
  };
}

/** SET-013: the footer data of the (unsaved) company form for the live preview; tax IDs come from the tax step. */
export function footerCompanyFromForm(
  v: CompanyValues,
  tax: { taxNumber?: string; taxNumberState?: string; vatId?: string } = {},
): FooterCompany {
  const p = companyPatchFromForm(v);
  return {
    legalForm: p.legalForm,
    name: p.name,
    ...(p.tradeName ? { tradeName: p.tradeName } : {}),
    address: p.address,
    ...(p.seat ? { seat: p.seat } : {}),
    contact: p.contact,
    ...(p.register ? { register: p.register } : {}),
    representatives: p.representatives,
    ...(p.generalPartner ? { generalPartner: p.generalPartner } : {}),
    ...(p.supervisoryBoardChair ? { supervisoryBoardChair: p.supervisoryBoardChair } : {}),
    ...(tax.taxNumber ? { taxNumber: tax.taxNumber } : {}),
    ...(tax.taxNumberState ? { taxNumberState: tax.taxNumberState } : {}),
    ...(tax.vatId ? { vatId: tax.vatId } : {}),
  };
}
