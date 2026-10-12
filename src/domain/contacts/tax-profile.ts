/**
 * Derived default tax case of a contact for a typical supply (F02 CON-045/046, CON-E10/E11/E26/E31/E33/E34; EC-042,
 * EC-043, EC-057). Display and input for the document derivation (F04 owns the per-document decision, PRD-009
 * place-of-supply exceptions and §13b); this function covers the general rules §3a Abs. 1/2 UStG (services) and
 * the destination rule for goods.
 */
import { euVatPrefixesAt, isEuVatCountry } from "../rules/eu-vat-countries";
import type { TaxCase } from "../tax/tax-case";
import type { CalendarDate } from "../time/calendar-date";
import { countryNameDe } from "./address";

export interface TaxProfileInput {
  readonly isConsumer: boolean;
  readonly isPublicAuthority: boolean;
  readonly vatId?: string | undefined;
  /** Latest check result of the current VAT ID. */
  readonly vatIdStatus?: { status: "valid" | "invalid" | "unavailable"; qualified: boolean } | undefined;
  readonly billingCountry?: string | undefined;
  /** Default delivery address country (goods destination, EC-042); falls back to the billing country. */
  readonly deliveryCountry?: string | undefined;
  readonly companyIsKleinunternehmer: boolean;
  readonly defaultTaxCase?: TaxCase | undefined;
  readonly today: CalendarDate;
}

export interface DerivedCase {
  readonly taxCase: TaxCase;
  readonly reason: string;
}

export interface TaxProfile {
  readonly service: DerivedCase;
  readonly goods: DerivedCase;
  readonly warnings: string[];
  /** EU consumer (or EU business treated as consumer): OSS threshold applies (UVA-07, CON-E31). */
  readonly euB2C: boolean;
  /** The contact's override (CON-044); documents still validate it. */
  readonly override?: TaxCase | undefined;
}

export function deriveTaxProfile(i: TaxProfileInput): TaxProfile {
  const warnings: string[] = [];
  const billing = (i.billingCountry ?? "DE").toUpperCase();
  const delivery = (i.deliveryCountry ?? billing).toUpperCase();
  const prefix = i.vatId?.slice(0, 2);
  const validVat = !!i.vatId && i.vatIdStatus?.status === "valid";
  const foreignEuVat = validVat && prefix !== "DE" && euVatPrefixesAt(i.today).prefixes.includes(prefix ?? "");
  const goodsOnlyPrefix = !!prefix && euVatPrefixesAt(i.today).goodsOnly.includes(prefix);
  // CON-E26: a valid USt-IdNr makes the contact a business for §3a regardless of the consumer flag.
  const business = !i.isConsumer || validVat;
  if (i.isConsumer && validVat) {
    warnings.push(
      "Privatkunde mit gültiger USt-IdNr: Für den Leistungsort wird ein Unternehmen angenommen (§ 3a UStG).",
    );
  }
  if (i.vatId && !validVat) {
    warnings.push("Die USt-IdNr ist nicht (gültig) geprüft — bitte „USt-IdNr prüfen“.");
  }
  if (prefix && prefix !== "XI") {
    const vatCountry = prefix === "EL" ? "GR" : prefix;
    if (vatCountry !== billing) {
      warnings.push(
        `Die USt-IdNr stammt aus ${countryNameDe(vatCountry)}, die Rechnungsadresse liegt in ${countryNameDe(billing)}. Bitte den Ort der Niederlassung des Leistungsempfängers bestätigen.`,
      );
    }
  }

  if (i.companyIsKleinunternehmer) {
    const ku: DerivedCase = {
      taxCase: "kleinunternehmer",
      reason: "Kleinunternehmerregelung (§ 19 UStG) Ihres Unternehmens",
    };
    return { service: ku, goods: ku, warnings, euB2C: false, override: i.defaultTaxCase };
  }

  const name = countryNameDe;
  const billingEu = billing === "XI" || isEuVatCountry(billing, i.today);
  let euB2C = false;

  // services (§3a Abs. 2 for businesses, Abs. 1 for consumers)
  let service: DerivedCase;
  if (billing === "DE") {
    service = { taxCase: "domestic", reason: "Inland (Deutschland)" };
  } else if (billingEu) {
    if (business && foreignEuVat && !goodsOnlyPrefix) {
      const how = i.vatIdStatus?.qualified ? "qualifiziert geprüft" : "einfach geprüft";
      service = { taxCase: "eu_b2b_service", reason: `EU-B2B-Leistung (${name(billing)}, USt-IdNr ${how})` };
    } else if (business && goodsOnlyPrefix && validVat) {
      service = {
        taxCase: "not_taxable_domestic",
        reason: "Nordirland (XI): Dienstleistungen werden wie an Unternehmen im Drittland behandelt (§ 3a Abs. 2 UStG)",
      };
    } else {
      euB2C = true;
      service = {
        taxCase: "domestic",
        reason: business
          ? `EU-Unternehmen ohne gültige USt-IdNr (${name(billing)}): wie Privatkunde mit deutscher Umsatzsteuer`
          : `EU-Privatkunde (${name(billing)}): deutsche Umsatzsteuer bis zur OSS-Lieferschwelle`,
      };
      if (business)
        warnings.push("EU-Unternehmen ohne gültige USt-IdNr wird wie ein Privatkunde behandelt — USt-IdNr prüfen.");
    }
  } else if (business) {
    service = {
      taxCase: "not_taxable_domestic",
      reason: `Unternehmen im Drittland (${name(billing)}): nicht im Inland steuerbar (§ 3a Abs. 2 UStG)`,
    };
  } else {
    service = {
      taxCase: "domestic",
      reason: `Privatkunde im Drittland (${name(billing)}): Leistungsort Deutschland (§ 3a Abs. 1 UStG)`,
    };
  }

  // goods (destination of the delivery, EC-042)
  let goods: DerivedCase;
  const deliveryEu = delivery === "XI" || isEuVatCountry(delivery, i.today);
  const xiGoods = goodsOnlyPrefix && validVat && (delivery === "GB" || delivery === "XI");
  if (delivery === "DE") {
    goods = {
      taxCase: "domestic",
      reason: foreignEuVat
        ? "Lieferung nach Deutschland: keine innergemeinschaftliche Lieferung trotz EU-USt-IdNr (die Ware verlässt Deutschland nicht)"
        : "Lieferung im Inland",
    };
  } else if (xiGoods || (deliveryEu && business && foreignEuVat)) {
    goods = {
      taxCase: "intra_community_supply",
      reason: `Innergemeinschaftliche Lieferung nach ${name(delivery === "XI" ? "GB" : delivery)}`,
    };
  } else if (deliveryEu) {
    euB2C = true;
    goods = {
      taxCase: "domestic",
      reason: `Lieferung an EU-Privatkunden (${name(delivery)}): deutsche Umsatzsteuer bis zur OSS-Lieferschwelle`,
    };
  } else {
    goods = { taxCase: "export", reason: `Ausfuhrlieferung nach ${name(delivery)}` };
  }
  return { service, goods, warnings, euB2C, override: i.defaultTaxCase };
}
