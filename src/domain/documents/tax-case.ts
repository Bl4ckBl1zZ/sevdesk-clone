/**
 * Per-document tax-case derivation `deriveTaxCase()` (F04 DOC-11, §4.5, App. C; T-TAB-01/02).
 *
 * Built on the contact-level profile (`deriveTaxProfile`, F02 CON-045: §3a Abs. 1/2 for services, destination rule
 * for goods) and adds the document rules of App. C.2: override (row 1), margin schemes (2), Kleinunternehmer (3–5),
 * place-of-supply exceptions in Germany (6), all-exempt / all-§13b documents for German businesses (7/8), and the
 * §3a Abs. 4 catalogue services to non-EU consumers (17). First matching row wins.
 */
import { deriveTaxProfile } from "../contacts/tax-profile";
import { euVatPrefixesAt, isEuVatCountry } from "../rules/eu-vat-countries";
import type { VatCategory } from "../tax/vat-category";
import type { CalendarDate } from "../time/calendar-date";
import type { TaxCase } from "./snapshot";

export type DerivableTaxCase = Exclude<TaxCase, "unknown_imported">;

export interface TaxCaseLine {
  readonly productType?: "good" | "service" | undefined;
  readonly placeOfSupplyRule?: string | undefined;
  readonly reverseCharge13b?: string | undefined;
  readonly vatRateKey?: string | undefined;
}

export interface TaxCaseInput {
  /** Company is Kleinunternehmer at the supply date (F01 SET-032). */
  readonly companyIsKleinunternehmer: boolean;
  readonly companyHasVatId: boolean;
  readonly contact: {
    readonly countryCode: string;
    readonly isConsumer: boolean;
    readonly isPublicAuthority: boolean;
    readonly vatId?: string | undefined;
    readonly vatIdStatus?: { status: "valid" | "invalid" | "unavailable"; qualified: boolean } | undefined;
    readonly defaultTaxCase?: TaxCase | undefined;
  } | null;
  /** BG-15 delivery country of goods (defaults to the contact country). */
  readonly deliveryCountry?: string | undefined;
  readonly lines: readonly TaxCaseLine[];
  readonly override?: TaxCase | undefined;
  readonly marginScheme?: boolean;
  readonly date: CalendarDate;
}

export type TaxCaseDerivation =
  | {
      readonly kind: "ok";
      readonly taxCase: DerivableTaxCase;
      /** App. C row that matched. */
      readonly row: number;
      readonly categoriesAllowed: readonly VatCategory[];
      readonly reasons: readonly string[];
      readonly warnings: readonly string[];
      /** EU consumer: OSS threshold applies (UVA-07). */
      readonly euB2C: boolean;
    }
  | {
      readonly kind: "blocked";
      readonly code: "margin_scheme_blocked" | "ku_foreign_service_no_vat_id";
      readonly message: string;
    };

/** App. C.3 */
export const CATEGORIES_BY_TAX_CASE: Readonly<Record<DerivableTaxCase, readonly VatCategory[]>> = {
  domestic: ["S", "Z", "E", "AE"],
  kleinunternehmer: ["KU"],
  eu_b2b_service: ["AE"],
  intra_community_supply: ["K"],
  export: ["G"],
  not_taxable_domestic: ["O"],
  reverse_charge_13b: ["AE"],
  exempt_4: ["E"],
};

const DOMESTIC_PLACE_RULES = new Set(["property", "event_admission", "restaurant", "short_term_vehicle_rental"]);

const isGood = (l: TaxCaseLine) => l.productType === "good";
const isService = (l: TaxCaseLine) => l.productType !== "good";

export function deriveTaxCase(input: TaxCaseInput): TaxCaseDerivation {
  const c = input.contact ?? { countryCode: "DE", isConsumer: false, isPublicAuthority: false };
  const country = c.countryCode.toUpperCase();
  const business = !c.isConsumer || c.isPublicAuthority;
  const ok = (
    taxCase: DerivableTaxCase,
    row: number,
    reason: string,
    warnings: readonly string[] = [],
    euB2C = false,
  ): TaxCaseDerivation => ({
    kind: "ok",
    taxCase,
    row,
    categoriesAllowed: CATEGORIES_BY_TAX_CASE[taxCase],
    reasons: [reason],
    warnings,
    euB2C,
  });

  // Row 1: document override, then contact default (validated by the category rules).
  const chosen = input.override ?? c.defaultTaxCase;
  if (chosen && chosen !== "unknown_imported") {
    return ok(chosen, 1, input.override ? "Steuerfall manuell festgelegt." : "Standard-Steuerfall des Kontakts.");
  }
  // Row 2
  if (input.marginScheme) {
    return {
      kind: "blocked",
      code: "margin_scheme_blocked",
      message:
        "Differenzbesteuerung und Reiseleistungen (§§ 25, 25a UStG) werden in dieser Version nicht unterstützt. Bitte mit einem Steuerberater abstimmen.",
    };
  }
  // Rows 3–5: Kleinunternehmer
  if (input.companyIsKleinunternehmer) {
    const kuReason = "Sie sind Kleinunternehmer (§ 19 UStG).";
    if (country === "DE" || c.isConsumer) return ok("kleinunternehmer", 3, kuReason);
    const generalServicesOnly =
      input.lines.length > 0 &&
      input.lines.every((l) => isService(l) && (l.placeOfSupplyRule ?? "general") === "general");
    if (generalServicesOnly) {
      if (isEuVatCountry(country, input.date)) {
        if (!input.companyHasVatId) {
          // LEGAL-OPEN: F04 9.11 — KU without own VAT ID performing EU B2B services (needs a USt-IdNr, § 27a UStG).
          return {
            kind: "blocked",
            code: "ku_foreign_service_no_vat_id",
            message:
              "Für Leistungen an Unternehmen im EU-Ausland benötigen Sie eine eigene USt-IdNr (auch als Kleinunternehmer).",
          };
        }
        return ok("eu_b2b_service", 4, "Kleinunternehmer, Dienstleistung an ein EU-Unternehmen → Reverse Charge.");
      }
      return ok("not_taxable_domestic", 4, "Kleinunternehmer, Dienstleistung an ein Unternehmen im Drittland.");
    }
    return ok("kleinunternehmer", 5, kuReason);
  }

  const profile = deriveTaxProfile({
    isConsumer: c.isConsumer,
    isPublicAuthority: c.isPublicAuthority,
    vatId: c.vatId,
    vatIdStatus: c.vatIdStatus,
    billingCountry: country,
    deliveryCountry: input.deliveryCountry ?? country,
    companyIsKleinunternehmer: false,
    today: input.date,
  });

  // Row 6: services performed in Germany regardless of the customer's seat.
  if (
    country !== "DE" &&
    input.lines.some((l) => isService(l) && DOMESTIC_PLACE_RULES.has(l.placeOfSupplyRule ?? ""))
  ) {
    return ok(
      "domestic",
      6,
      "Leistungsort Deutschland (z. B. Grundstück, Veranstaltung, Restaurant) → deutsche Umsatzsteuer.",
    );
  }

  if (country === "DE") {
    const items = input.lines;
    // Row 7
    if (business && items.length > 0 && items.every((l) => l.vatRateKey === "exempt")) {
      return ok("exempt_4", 7, "Alle Positionen sind nach § 4 UStG steuerfrei.");
    }
    // Row 8
    if (business && !c.isPublicAuthority && items.length > 0 && items.every((l) => !!l.reverseCharge13b)) {
      return ok(
        "reverse_charge_13b",
        8,
        "Alle Positionen fallen unter § 13b UStG → Steuerschuldnerschaft des Leistungsempfängers.",
      );
    }
    // Rows 9 / 19
    return ok(
      "domestic",
      c.isPublicAuthority ? 19 : 9,
      c.isConsumer ? "Privatkunde in Deutschland." : "Kunde in Deutschland.",
    );
  }

  const hasGoods = input.lines.some(isGood);
  const eu = country === "XI" || isEuVatCountry(country, input.date);
  if (hasGoods) {
    const g = profile.goods;
    const row =
      g.taxCase === "intra_community_supply" ? 10 : g.taxCase === "export" ? 15 : eu ? (business ? 11 : 14) : 18;
    return ok(g.taxCase as DerivableTaxCase, row, `${g.reason}.`, profile.warnings, profile.euB2C);
  }
  // Row 17: §3a Abs. 4 catalogue services to non-EU consumers.
  if (
    !eu &&
    c.isConsumer &&
    input.lines.length > 0 &&
    input.lines.every((l) => l.placeOfSupplyRule === "catalogue_3a4")
  ) {
    return ok(
      "not_taxable_domestic",
      17,
      "Katalogleistung an Privatkunden im Drittland → nicht im Inland steuerbar (§ 3a Abs. 4 UStG).",
    );
  }
  const s = profile.service;
  const row = s.taxCase === "eu_b2b_service" ? 12 : eu ? (business ? 13 : 14) : business ? 16 : 18;
  const goodsOnlyXi = euVatPrefixesAt(input.date).goodsOnly.includes(c.vatId?.slice(0, 2) ?? "");
  return ok(s.taxCase as DerivableTaxCase, goodsOnlyXi ? 16 : row, `${s.reason}.`, profile.warnings, profile.euB2C);
}

/**
 * Default category of a line for the tax case (App. C.2 "default category"). `rateCategory` is the category of the
 * line's `vatRateKey` at the supply date (S/Z/E), used for domestic documents. §13b lines are AE line-wise in domestic
 * documents for business customers (row 9).
 */
export function defaultCategoryFor(
  taxCase: TaxCase,
  line: { readonly reverseCharge13b?: string | undefined },
  rateCategory: "S" | "Z" | "E",
  businessCustomer: boolean,
): VatCategory {
  switch (taxCase) {
    case "kleinunternehmer":
      return "KU";
    case "eu_b2b_service":
    case "reverse_charge_13b":
      return "AE";
    case "intra_community_supply":
      return "K";
    case "export":
      return "G";
    case "not_taxable_domestic":
      return "O";
    case "exempt_4":
      return "E";
    default:
      return line.reverseCharge13b && businessCustomer ? "AE" : rateCategory;
  }
}
