/**
 * `validateDocument()` (F04 §5.1, DOC-20, DOC-24 step 1a/2a): the same validators run in the compliance panel on
 * every change, in the preview, and again inside the commit transaction against freshly read company/contact data
 * (EC-004). Drafts can always be saved; E findings block "Fertigstellen".
 *
 * Scope of this slice (P1 invoices core): parties, dates, lines/amounts, tax, currency and e-invoice codes of
 * §5.1.1–§5.1.5/§5.1.7 that apply to plain invoices. Chain/correction codes (§5.1.6) arrive with their slices.
 */
import { isValidIBAN } from "ibantools";
import { certificateGate } from "../../contacts/consent";
import { vatCheckGate } from "../../contacts/vat-check";
import { validateLeitwegId } from "../../einvoice/leitweg-id";
import { isSupportedCurrency } from "../../money/currencies";
import { formatBasisPoints, formatEuro, formatMilli } from "../../money/format";
import { lineAmountCents } from "../../money/line";
import { revenueAccountIssue } from "../../products/revenue-account";
import { isEuVatCountry, isEuVatPrefix } from "../../rules/eu-vat-countries";
import { lookupRule } from "../../rules/rule-table";
import { isWithinKleinbetragLimit, KLEINUNTERNEHMER_LIMITS } from "../../rules/thresholds";
import { TAX_CASE_LABELS } from "../../tax/tax-case";
import { ossBlock } from "../../tax/turnover";
import { validateVatId } from "../../tax/vat-id";
import { addDays, type CalendarDate, daysBetween, formatGermanDate } from "../../time/calendar-date";
import { DOC_TYPE_PLURAL_DE } from "../doc-types";
import {
  type DocumentContext,
  type DraftDocument,
  ossNetEurCentsOf,
  type ResolvedDraft,
  resolveDraft,
  supplyRange,
  toLineDiscount,
} from "../draft";
import type { SalesDocType } from "../snapshot";
import { CATEGORIES_BY_TAX_CASE } from "../tax-case";
import { chainFindings } from "./chain";
import { type EinvoicePlan, isXRechnungFormat, planEinvoice } from "./einvoice-plan";
import { type Finding, finding } from "./finding";

export { type EinvoicePlan, planEinvoice } from "./einvoice-plan";
export { blocking, type Finding, isBlocking } from "./finding";

const INVOICE_TYPES: readonly SalesDocType[] = ["invoice", "advance_invoice", "partial_invoice", "final_invoice"];
const MAX_LINES = 2000;
const DOMESTIC_CATEGORIES: readonly string[] = ["S", "Z", "E"];
const MAX_AMOUNT_CENTS = 9_999_999_999_999;
const GENERIC = new Set([
  "leistung",
  "leistungen",
  "diverses",
  "sonstiges",
  "pauschale",
  "beratung",
  "waren",
  "material",
  "arbeit",
  "dienstleistung",
  "service",
]);
const de = (d: string) => formatGermanDate(d as CalendarDate);

export interface ValidationResult {
  readonly findings: readonly Finding[];
  readonly resolved: ResolvedDraft;
  readonly einvoice: EinvoicePlan;
  /** INV-28 / EC-044: the VAT-ID check was released by an audited override → the check must be repeated later. */
  readonly overriddenVatCheck?: { readonly vatId: string; readonly qualifiedRequired: boolean } | undefined;
}

export interface ValidateOptions {
  /** Released `buyer_vat_id_not_verified` with an audited reason (EC-044). */
  readonly vatCheckOverride?: boolean | undefined;
  /** Confirmed "Kunde erbringt selbst Bauleistungen" for a missing/expired USt 1 TG (CON-071). */
  readonly rc13bConfirmed?: boolean | undefined;
}

export function validateDocument(
  draft: DraftDocument,
  ctx: DocumentContext,
  opts: ValidateOptions = {},
): ValidationResult {
  const resolved = resolveDraft(draft, ctx);
  const einvoice = planEinvoice(draft, ctx, resolved);
  const out: Finding[] = [];
  const push = (f: Finding) => out.push(f);
  let overriddenVatCheck: ValidationResult["overriddenVatCheck"];
  const isInvoice = INVOICE_TYPES.includes(draft.type);
  const c = ctx.contact;
  const items = draft.lines.filter((l) => l.kind === "item" && !l.optional);
  /** Delivery notes without printed prices keep prices internally but need none (QUO-09). */
  const priced = draft.type !== "delivery_note" || draft.showPrices === true;
  const today = ctx.today;
  const docDate = resolved.documentDate;
  const supply = resolved.supplyDate;
  const range = supplyRange(supply);
  const totals = resolved.totals;
  const cats = new Set(resolved.lines.map((l) => l.vatCategory));
  const taxCase = resolved.taxCase;

  // ── infrastructure gates (step 0) ───────────────────────────────────────────────────────────────────────────
  if (!ctx.setupComplete) {
    push(
      finding(
        "setup_incomplete",
        "E",
        "MAIL-03",
        "pflichtangaben",
        "Die Einrichtung ist noch nicht abgeschlossen → Einrichtung fortsetzen.",
        {
          field: "settings/setup",
        },
      ),
    );
  }
  if (ctx.integrityAlertOpen) {
    push(
      finding(
        "integrity_alert_open",
        "E",
        "GOBD-06",
        "pflichtangaben",
        "Die Integritätsprüfung hat einen Fehler gemeldet. Bitte zuerst unter Einstellungen › System prüfen und bestätigen.",
        { field: "settings/system" },
      ),
    );
  }
  if (!ctx.numberRangeAvailable) {
    push(
      finding(
        "number_range_missing",
        "E",
        "UST-06",
        "pflichtangaben",
        `Kein aktiver Nummernkreis für ${DOC_TYPE_PLURAL_DE[draft.type]} → Einstellungen › Nummernkreise.`,
        {
          field: "settings/number-ranges",
          params: { docType: draft.type },
        },
      ),
    );
  }

  // DOC-53: required document custom fields.
  for (const f of ctx.requiredDocumentFields ?? []) {
    const value = draft.customFields?.[f.key];
    if (value === undefined || value === "") {
      push(
        finding("custom_field_missing", "E", "DOC-53", "pflichtangaben", `Pflichtfeld „${f.label}“ fehlt.`, {
          field: `customFields.${f.key}`,
        }),
      );
    }
  }

  // ── §5.1.1 parties ──────────────────────────────────────────────────────────────────────────────────────────
  const kleinbetrag = draft.kleinbetrag === true;
  if (!c) {
    push(finding("contact_missing", "E", "UST-03", "pflichtangaben", "Kein Kunde ausgewählt.", { field: "contactId" }));
  } else {
    if (!c.buyer.name.trim()) {
      push(
        finding("buyer_name_missing", "E", "UST-03", "pflichtangaben", "Name des Kunden fehlt.", {
          field: "contactId",
        }),
      );
    }
    const a = c.buyer.address;
    if (!kleinbetrag) {
      const missing: string[] = [];
      if (!a || (!a.street.trim() && !a.poBox?.trim())) missing.push("Straße");
      if (!a?.postalCode.trim() && a?.countryCode !== "IE") missing.push("PLZ");
      if (!a?.city.trim()) missing.push("Ort");
      if (!a?.countryCode.trim()) missing.push("Land");
      if (missing.length > 0) {
        push(
          finding(
            "buyer_address_incomplete",
            "E",
            "UST-03",
            "pflichtangaben",
            `Anschrift des Kunden unvollständig: ${missing.join(", ")} fehlt.`,
            {
              field: "billingAddress",
              params: { fields: missing.join(", ") },
            },
          ),
        );
      }
    }
  }
  for (const i of ctx.company.validation.blocking) {
    const field = (i.params?.field as string | undefined) ?? "";
    if (
      i.code === "address_incomplete" ||
      i.code === "postal_code_invalid" ||
      (i.code === "required" && field === "name")
    ) {
      push(
        finding(
          "seller_address_incomplete",
          "E",
          "UST-03",
          "pflichtangaben",
          "Firmenanschrift unvollständig → Einstellungen › Unternehmen.",
          {
            field: "settings/company",
          },
        ),
      );
    } else if (i.code === "tax_id_missing") {
      if (isInvoice) {
        push(
          finding(
            "seller_tax_id_missing",
            "E",
            "UST-04",
            "pflichtangaben",
            "Steuernummer oder USt-IdNr. des Unternehmens fehlt → Einstellungen › Steuern.",
            { field: "settings/tax" },
          ),
        );
      }
    } else if (i.code === "contact_missing") {
      if (einvoice.format !== "none") {
        push(
          finding(
            "seller_contact_missing",
            "E",
            "ER-10",
            "e_rechnung",
            "Für E-Rechnungen fehlen Kontaktangaben des Unternehmens (Name, Telefon, E-Mail) → Einstellungen › Unternehmen.",
            { field: "settings/company" },
          ),
        );
      }
    } else {
      push(
        finding(
          "geschaeftsbrief_incomplete",
          "E",
          "MAIL-03",
          "pflichtangaben",
          `Pflichtangabe für Geschäftsbriefe fehlt: ${i.message} (Rechtsform ${ctx.company.seller.legalForm}) → Einstellungen › Unternehmen.`,
          { field: "settings/company", params: { item: i.message, legalForm: ctx.company.seller.legalForm } },
        ),
      );
    }
  }
  if ((cats.has("K") || (cats.has("AE") && taxCase === "eu_b2b_service")) && !ctx.company.seller.vatId) {
    push(
      finding(
        "seller_vat_id_required",
        "E",
        "UST-20",
        "steuern",
        "Für innergemeinschaftliche Umsätze ist die eigene USt-IdNr. Pflicht (§ 14a UStG) → Einstellungen › Steuern.",
        { field: "settings/tax" },
      ),
    );
  }
  if (kleinbetrag && totals) {
    const within = isWithinKleinbetragLimit(resolved.grossEurCents ?? totals.grossCents, docDate);
    if (!(within.ok && within.value) || cats.has("K") || cats.has("AE")) {
      push(
        finding(
          "kleinbetrag_not_allowed",
          "E",
          "UST-14",
          "pflichtangaben",
          "Kleinbetragsrechnung nur bis 250,00 € brutto und nicht für innergemeinschaftliche Lieferungen, Fernverkäufe oder § 13b UStG.",
          { field: "kleinbetrag" },
        ),
      );
    }
  }

  // ── §5.1.2 dates ────────────────────────────────────────────────────────────────────────────────────────────
  if ((isInvoice || draft.type === "delivery_note") && !supply) {
    push(
      finding("supply_date_missing", "E", "UST-08", "pflichtangaben", "Leistungsdatum oder Leistungszeitraum fehlt.", {
        field: "supplyDate",
      }),
    );
  }
  const badPeriod =
    (supply?.kind === "period" && supply.to < supply.from) ||
    draft.lines.some(
      (l) =>
        l.linePeriod &&
        (l.linePeriod.to < l.linePeriod.from ||
          (range && supply?.kind !== "date" && (l.linePeriod.from < range.from || l.linePeriod.to > range.to))),
    );
  if (badPeriod) {
    push(
      finding(
        "supply_period_invalid",
        "E",
        "UST-08",
        "pflichtangaben",
        "Leistungszeitraum ungültig: Ende liegt vor Beginn.",
        { field: "supplyDate" },
      ),
    );
  }
  if (range && (draft.type === "invoice" || draft.type === "final_invoice") && range.from > docDate) {
    push(
      finding(
        "supply_date_in_future",
        "E",
        "UST-08",
        "pflichtangaben",
        `Das Leistungsdatum (${de(range.from)}) liegt nach dem Rechnungsdatum. Für Vorauszahlungen bitte eine Abschlagsrechnung erstellen.`,
        { field: "supplyDate", params: { date: range.from } },
      ),
    );
  } else if (range && draft.type === "invoice" && range.to > docDate && range.from <= docDate) {
    push(
      finding(
        "supply_period_ends_after_date",
        "I",
        "UST-40",
        "hinweise",
        "Der Leistungszeitraum endet nach dem Rechnungsdatum (Vorausberechnung). Die Umsatzsteuer entsteht ggf. bereits mit Zahlungseingang.",
        { field: "supplyDate" },
      ),
    );
  }
  for (const l of resolved.lines) {
    if (l.rateIssue) {
      push(
        finding(l.rateIssue.code, "E", "UST-15", "steuern", l.rateIssue.message, {
          field: `lines.${l.index}.linePeriod`,
          ...(l.rateIssue.params ? { params: l.rateIssue.params } : {}),
        }),
      );
    }
    if (l.rateChanged) {
      push(
        finding(
          "rate_changed_notice",
          "I",
          "UST-15",
          "steuern",
          `Steuersatz geändert: ${formatBasisPoints(l.rateChanged.from)} % → ${formatBasisPoints(l.rateChanged.to)} % (Leistungsdatum ${de(l.rateChanged.date)}).`,
          {
            field: `lines.${l.index}.vatRateKey`,
            params: { old: l.rateChanged.from, new: l.rateChanged.to, date: l.rateChanged.date },
          },
        ),
      );
    }
  }
  if (isInvoice && range) {
    const kuFrom = resolved.kleinunternehmer;
    const change = ctx.company.kleinunternehmer.find(
      (e) => e.validFrom > range.from && e.validFrom <= range.to && e.isKU !== kuFrom,
    );
    const startKu = ctx.company.kleinunternehmer.filter((e) => e.validFrom <= range.from).at(-1)?.isKU ?? false;
    if (change || startKu !== kuFrom) {
      const at = change?.validFrom ?? range.to;
      push(
        finding(
          "supply_period_crosses_ku_change",
          "E",
          "KU-01",
          "steuern",
          `Leistungszeitraum überschreitet den Wechsel der Kleinunternehmerregelung am ${de(at)} — bitte Rechnung aufteilen.`,
          { field: "supplyDate", params: { date: at } },
        ),
      );
    }
    if (range.to < addDays(docDate, -183)) {
      push(
        finding(
          "supply_older_than_6_months",
          "W",
          "UST-01",
          "hinweise",
          "Die Leistung liegt mehr als 6 Monate zurück. Die Frist zur Rechnungsstellung (§ 14 Abs. 2 UStG) ist überschritten – bitte trotzdem jetzt ausstellen.",
          { field: "supplyDate" },
        ),
      );
    }
  }
  if (docDate > today) {
    push(
      finding(
        "document_date_future",
        "E",
        "UST-05",
        "pflichtangaben",
        "Das Dokumentdatum darf nicht in der Zukunft liegen.",
        { field: "documentDate" },
      ),
    );
  } else {
    const back = daysBetween(docDate, today);
    if (back > ctx.company.backdateWindowDays && !(draft.backdateReason ?? "").trim()) {
      push(
        finding(
          "backdate_reason_required",
          "E",
          "UST-05",
          "pflichtangaben",
          `Rückdatierung um ${back} Tage: bitte eine Begründung angeben (wird protokolliert).`,
          { field: "backdateReason", params: { days: back } },
        ),
      );
    }
    if (docDate < addDays(today, -183)) {
      push(
        finding(
          "backdate_over_6_months",
          "W",
          "UST-05",
          "hinweise",
          "Das Datum liegt mehr als 6 Monate zurück. Bitte prüfen, ob das wirklich gewollt ist.",
          { field: "documentDate" },
        ),
      );
    }
    if (isInvoice && ctx.lockedThrough && docDate <= ctx.lockedThrough) {
      push(
        finding(
          "backdate_period_locked",
          "E",
          "GOBD-06",
          "pflichtangaben",
          `Der Zeitraum ${docDate.slice(0, 7)} ist festgeschrieben bzw. die Umsatzsteuer-Voranmeldung wurde abgegeben. Bitte das aktuelle Datum verwenden.`,
          { field: "documentDate", params: { period: docDate.slice(0, 7) } },
        ),
      );
    }
  }
  if (draft.type === "quote" && draft.validUntil && draft.validUntil < docDate) {
    push(
      finding(
        "valid_until_before_date",
        "E",
        "—",
        "pflichtangaben",
        "„Gültig bis“ darf nicht vor dem Angebotsdatum liegen.",
        { field: "validUntil" },
      ),
    );
  }
  if (isInvoice && range && (taxCase === "eu_b2b_service" || taxCase === "intra_community_supply")) {
    const [y, m] = range.to.split("-").map(Number) as [number, number];
    const deadline = (m === 12 ? `${y + 1}-01-15` : `${y}-${String(m + 1).padStart(2, "0")}-15`) as CalendarDate;
    if (today > deadline) {
      push(
        finding(
          "deadline_14a_missed",
          "W",
          "UST-02",
          "hinweise",
          `Die Frist nach § 14a UStG (${de(deadline)}) ist überschritten – bitte umgehend ausstellen.`,
          {
            params: { date: deadline },
          },
        ),
      );
    } else if (today >= addDays(deadline, -3)) {
      push(
        finding(
          "deadline_14a",
          "W",
          "UST-02",
          "hinweise",
          `Diese Rechnung muss bis ${de(deadline)} ausgestellt werden (§ 14a UStG).`,
          {
            params: { date: deadline },
          },
        ),
      );
    } else {
      // INV-27: the editor always names the deadline; it becomes a warning 3 days before.
      push(
        finding(
          "deadline_14a_info",
          "I",
          "UST-02",
          "hinweise",
          `Rechnung bis ${de(deadline)} ausstellen (§ 14a UStG).`,
          {
            params: { date: deadline },
          },
        ),
      );
    }
  }

  // ── §5.1.3 lines and amounts ────────────────────────────────────────────────────────────────────────────────
  if (items.length === 0) {
    push(
      finding("no_items", "E", "UST-07", "pflichtangaben", "Das Dokument enthält keine Positionen.", {
        field: "lines",
      }),
    );
  }
  if (draft.lines.length > MAX_LINES) {
    push(
      finding(
        "too_many_lines",
        "E",
        "ER-01",
        "pflichtangaben",
        "Ein Dokument darf höchstens 2.000 Positionen enthalten.",
        { field: "lines" },
      ),
    );
  }
  resolved.lines.forEach((r) => {
    const l = draft.lines[r.index];
    if (!l) return;
    const n = r.position;
    const field = (f: string) => `lines.${r.index}.${f}`;
    if (!(l.name ?? "").trim()) {
      push(
        finding("line_name_missing", "E", "UST-07", "pflichtangaben", `Position ${n}: Bezeichnung fehlt.`, {
          field: field("name"),
          params: { n },
        }),
      );
    } else {
      const text = `${l.name ?? ""} ${l.description ?? ""}`.trim().toLocaleLowerCase("de");
      if (GENERIC.has(text)) {
        push(
          finding(
            "generic_description",
            "W",
            "UST-07",
            "pflichtangaben",
            `Position ${n}: „${l.name}“ ist sehr allgemein. Bitte Art und Umfang konkret beschreiben, sonst gefährdet das den Vorsteuerabzug Ihres Kunden.`,
            { field: field("name"), params: { n, text: l.name ?? "" } },
          ),
        );
      }
      if ((l.name ?? "").length > 250) {
        push(
          finding(
            "text_too_long",
            "E",
            "ER-01",
            "pflichtangaben",
            `Bezeichnung ist zu lang (${(l.name ?? "").length} von max. 250 Zeichen).`,
            {
              field: field("name"),
              params: { field: "Bezeichnung", length: (l.name ?? "").length, max: 250 },
            },
          ),
        );
      }
    }
    if (!l.quantityMilli) {
      push(
        finding("line_quantity_invalid", "E", "UST-07", "pflichtangaben", `Position ${n}: Menge fehlt oder ist 0.`, {
          field: field("quantityMilli"),
          params: { n },
        }),
      );
    }
    if (!l.unitCode) {
      push(
        finding("line_unit_missing", "E", "UST-07", "pflichtangaben", `Position ${n}: Einheit fehlt.`, {
          field: field("unitCode"),
          params: { n },
        }),
      );
    } else if (!ctx.unitCodes.has(l.unitCode)) {
      push(
        finding(
          "line_unit_invalid",
          "E",
          "UST-07",
          "pflichtangaben",
          `Position ${n}: „${l.unitCode}“ ist kein gültiger Einheitencode nach UN/ECE Rec 20/21.`,
          {
            field: field("unitCode"),
            params: { n, code: l.unitCode },
          },
        ),
      );
    }
    if (l.unitPriceMicros === undefined && priced) {
      push(
        finding("line_price_missing", "E", "UST-09", "pflichtangaben", `Position ${n}: Einzelpreis fehlt.`, {
          field: field("unitPriceMicros"),
          params: { n },
        }),
      );
    }
    const q = l.quantityMilli ?? 0;
    const p = l.unitPriceMicros ?? 0;
    try {
      const gross = lineAmountCents(q, p);
      const net = lineAmountCents(q, p, toLineDiscount(l.discount));
      const discount = toLineDiscount(l.discount);
      if (discount && ((gross >= 0 && net < 0) || (discount.kind === "percent" && discount.bp > 10_000))) {
        push(
          finding(
            "line_discount_exceeds",
            "E",
            "UST-09",
            "pflichtangaben",
            `Position ${n}: Der Rabatt ist höher als der Positionsbetrag.`,
            { field: field("discount"), params: { n } },
          ),
        );
      } else if (isInvoice && net < 0) {
        push(
          finding(
            "negative_line",
            "W",
            "UST-30",
            "hinweise",
            `Position ${n} ist negativ. Für Minderungen bereits ausgestellter Rechnungen bitte eine Rechnungskorrektur verwenden.`,
            { field: field("quantityMilli"), params: { n } },
          ),
        );
      }
    } catch {
      // amount_too_large is reported once from the totals below
    }
  });
  if (resolved.totalsIssue) {
    const tooLarge = resolved.totalsIssue.code === "amount_too_large";
    push(
      finding(
        tooLarge ? "amount_too_large" : "document_discount_exceeds",
        "E",
        tooLarge ? "GOBD-03" : "UST-09",
        "pflichtangaben",
        tooLarge
          ? "Der Betrag ist zu groß (maximal 99.999.999.999,99)."
          : "Der Gesamtrabatt ist höher als die Zwischensumme.",
        { field: tooLarge ? "lines" : "documentDiscount" },
      ),
    );
  }
  if (totals) {
    if (totals.groups.some((g) => g.baseCents < 0 && g.allowanceCents > 0 && g.lineNetSumCents >= 0)) {
      push(
        finding(
          "document_discount_exceeds",
          "E",
          "UST-09",
          "pflichtangaben",
          "Der Gesamtrabatt ist höher als die Zwischensumme.",
          { field: "documentDiscount" },
        ),
      );
    }
    if ((isInvoice || draft.type === "proforma") && totals.grossCents < 0) {
      push(
        finding(
          "total_negative",
          "E",
          "UST-30",
          "pflichtangaben",
          "Der Rechnungsbetrag darf nicht negativ sein. Für Minderungen bitte eine Rechnungskorrektur erstellen.",
          { field: "lines" },
        ),
      );
    } else if (isInvoice && totals.grossCents === 0 && items.length > 0) {
      push(finding("total_zero", "W", "—", "hinweise", "Der Rechnungsbetrag beträgt 0,00 €.", { field: "lines" }));
    }
    if (Math.abs(totals.grossCents) > MAX_AMOUNT_CENTS) {
      push(
        finding(
          "amount_too_large",
          "E",
          "GOBD-03",
          "pflichtangaben",
          "Der Betrag ist zu groß (maximal 99.999.999.999,99).",
          { field: "lines" },
        ),
      );
    }
    for (const w of totals.warnings) {
      push(finding(w.code, "W", "UST-10", "hinweise", w.message, { ...(w.params ? { params: w.params } : {}) }));
    }
  }
  if (c?.isConsumer && draft.priceMode === "net") {
    push(
      finding(
        "consumer_net_prices",
        "W",
        "MISC-03",
        "hinweise",
        "Privatkunde: Preise sollten brutto ausgewiesen werden (PAngV). Auf Bruttopreise umstellen?",
        {
          field: "priceMode",
        },
      ),
    );
  }
  for (const [key, label, max] of [
    ["subject", "Betreff", 250],
    ["headText", "Kopftext", 20_000],
    ["footText", "Fußtext", 20_000],
    ["buyerReference", "Käuferreferenz", 100],
    ["orderReference", "Bestellnummer", 100],
    ["contractReference", "Vertragsnummer", 100],
  ] as const) {
    const v = draft[key] ?? "";
    if (v.length > max) {
      push(
        finding(
          "text_too_long",
          "E",
          "ER-01",
          "pflichtangaben",
          `${label} ist zu lang (${v.length} von max. ${max} Zeichen).`,
          {
            field: key,
            params: { field: label, length: v.length, max },
          },
        ),
      );
    }
  }
  if (isInvoice && totals && c) {
    const supplyEndDate = range?.to;
    const dup = (ctx.recentInvoices ?? []).find(
      (d) =>
        d.grossCents === totals.grossCents &&
        (d.supplyEnd ?? d.documentDate) === (supplyEndDate ?? docDate) &&
        Math.abs(daysBetween(d.documentDate as CalendarDate, docDate)) <= 30,
    );
    if (dup) {
      push(
        finding(
          "possible_duplicate",
          "W",
          "UST-34",
          "hinweise",
          `Es gibt bereits ${dup.number} vom ${de(dup.documentDate)} an ${c.buyer.name} über ${formatEuro(dup.grossCents)}. Doppelte Rechnungen für dieselbe Leistung führen zur Steuerschuld nach § 14c UStG.`,
          {
            params: {
              number: dup.number,
              date: dup.documentDate,
              contact: c.buyer.name,
              amount: formatEuro(dup.grossCents),
            },
          },
        ),
      );
    }
  }
  const terms = draft.paymentTerms;
  if (c && !c.isConsumer && !c.isPublicAuthority && terms.dueDays > 60) {
    push(
      finding(
        "payment_terms_long_b2b",
        "W",
        "MAHN-04",
        "hinweise",
        `Zahlungsziel von ${terms.dueDays} Tagen: Über 60 Tage ist nur bei ausdrücklicher Vereinbarung wirksam (§ 271a BGB).`,
        { field: "paymentTerms.dueDays", params: { days: terms.dueDays } },
      ),
    );
  }
  if (c?.isPublicAuthority && terms.dueDays > 30) {
    push(
      finding(
        "payment_terms_long_public",
        "W",
        "MAHN-04",
        "hinweise",
        `Zahlungsziel von ${terms.dueDays} Tagen: Gegenüber öffentlichen Auftraggebern sind höchstens 30 Tage üblich (§ 271a BGB).`,
        { field: "paymentTerms.dueDays", params: { days: terms.dueDays } },
      ),
    );
  }
  if (terms.skontoPercentBp !== undefined || terms.skontoDays !== undefined) {
    const pct = terms.skontoPercentBp ?? 0;
    const days = terms.skontoDays ?? 0;
    if (pct <= 0 || pct > 1000 || days >= terms.dueDays || days <= 0) {
      push(
        finding(
          "skonto_invalid",
          "E",
          "UST-09",
          "pflichtangaben",
          "Skontofrist muss kürzer als das Zahlungsziel sein und der Skontosatz zwischen 0,01 % und 10 % liegen.",
          { field: "paymentTerms.skontoPercentBp" },
        ),
      );
    }
  }
  if (isInvoice && totals && totals.payableCents > 0 && ctx.paymentMethod.kind === "transfer") {
    if (!ctx.bankAccount) {
      push(
        finding(
          "bank_account_missing",
          "E",
          "ER-10",
          "pflichtangaben",
          "Bankverbindung fehlt (Zahlungsart Überweisung).",
          { field: "bankAccountId" },
        ),
      );
    } else if (!isValidIBAN(ctx.bankAccount.iban.replace(/\s/g, ""))) {
      push(
        finding("iban_invalid", "E", "ER-10", "pflichtangaben", `Die IBAN ${ctx.bankAccount.iban} ist ungültig.`, {
          field: "bankAccountId",
          params: { iban: ctx.bankAccount.iban },
        }),
      );
    }
  }

  // ── §5.1.4 tax ──────────────────────────────────────────────────────────────────────────────────────────────
  if (resolved.derivation.kind === "blocked") {
    push(
      finding(resolved.derivation.code, "E", "UST-24", "steuern", resolved.derivation.message, { field: "taxCase" }),
    );
  }
  if (draft.taxCaseOverride && draft.taxCaseOverride.reason.trim().length < 10) {
    push(
      finding(
        "tax_case_override_reason",
        "E",
        "UST-10",
        "steuern",
        "Bitte begründen, warum vom ermittelten Steuerfall abgewichen wird (mind. 10 Zeichen).",
        { field: "taxCaseOverride.reason" },
      ),
    );
  }
  const allowed = CATEGORIES_BY_TAX_CASE[taxCase];
  for (const r of resolved.lines) {
    const l = draft.lines[r.index];
    if (!l) continue;
    const n = r.position;
    if (!allowed.includes(r.vatCategory)) {
      push(
        finding(
          "category_not_allowed",
          "E",
          "UST-10",
          "steuern",
          `Position ${n}: USt-Kategorie „${r.vatCategory}“ ist im Steuerfall „${TAX_CASE_LABELS[taxCase]}“ nicht zulässig.`,
          { field: `lines.${r.index}.vatCategoryOverride`, params: { n, category: r.vatCategory, taxCase } },
        ),
      );
    }
    // PRD-051/052 (PRD-E17/E18): a line revenue account (domestic lines only) must still be a revenue account whose
    // automatic VAT matches the line's actual rate.
    if (l.kind === "item" && l.revenueAccount && ctx.chart && DOMESTIC_CATEGORIES.includes(r.vatCategory)) {
      const issue = revenueAccountIssue({
        chart: ctx.chart,
        account: l.revenueAccount,
        date: docDate ?? today,
        rates: [{ category: r.vatCategory, rateBp: r.vatRateBp }],
      });
      if (issue) {
        push(
          finding(issue.code.toLowerCase(), "E", "PRD-052", "steuern", `Position ${n}: ${issue.message}`, {
            field: `lines.${r.index}.revenueAccount`,
            params: { n, account: l.revenueAccount },
          }),
        );
      }
    }
    if (r.vatCategory === "AE" && taxCase === "domestic" && c?.isConsumer) {
      push(
        finding(
          "rc13b_consumer",
          "E",
          "UST-22",
          "steuern",
          "§ 13b UStG setzt einen Unternehmer als Leistungsempfänger voraus.",
          { field: `lines.${r.index}` },
        ),
      );
    }
    if (r.vatCategory === "E" && !l.exemptionReasonCode && !(l.exemptionReasonText ?? "").trim()) {
      push(
        finding(
          "exemption_reason_missing",
          "E",
          "UST-10",
          "steuern",
          `Position ${n}: Befreiungsgrund (§ 4 UStG) fehlt.`,
          {
            field: `lines.${r.index}.exemptionReasonCode`,
            params: { n },
          },
        ),
      );
    }
  }
  if (resolved.kleinunternehmer && (cats.has("S") || cats.has("Z"))) {
    push(
      finding(
        "ku_vat_not_allowed",
        "E",
        "KU-03",
        "steuern",
        "Als Kleinunternehmer dürfen Sie keine Umsatzsteuer ausweisen (§ 19 UStG; sonst Steuerschuld nach § 14c UStG).",
        { field: "lines" },
      ),
    );
  }
  if (resolved.kleinunternehmer && isInvoice) {
    const limits = lookupRule(KLEINUNTERNEHMER_LIMITS, docDate);
    if (limits.ok) {
      const L = limits.value.value;
      const year = Number(docDate.slice(0, 4));
      const prior = ctx.company.priorYearTurnover.find((t) => t.year === year - 1);
      if (prior && prior.amountCents > L.priorYearLimitCents) {
        push(
          finding(
            "ku_status_outdated",
            "E",
            "KU-01",
            "steuern",
            `Der Vorjahresumsatz liegt über ${formatEuro(L.priorYearLimitCents)} — die Kleinunternehmerregelung gilt ab 01.01.${year} nicht mehr. Bitte Steuerstatus aktualisieren.`,
            { field: "settings/tax", params: { year } },
          ),
        );
      }
      const founding = ctx.company.foundedOn?.slice(0, 4) === String(year);
      const limit = founding ? L.foundingYearLimitCents : L.currentYearLimitCents;
      const before = ctx.kuYearTurnoverCents ?? 0;
      const after = before + (resolved.grossEurCents ?? 0);
      if (after > limit) {
        push(
          finding(
            "ku_threshold_crossed",
            "E",
            "KU-01",
            "steuern",
            `Mit dieser Rechnung wird die Umsatzgrenze von ${formatEuro(limit)} überschritten. Diese und alle folgenden Rechnungen müssen mit Umsatzsteuer ausgestellt werden. Steuerstatus jetzt umstellen?`,
            { field: "settings/tax", params: { limit: formatEuro(limit) } },
          ),
        );
      } else {
        const bp = Math.floor((after * 10_000) / limit);
        const level = [...L.warnAtBp].reverse().find((w) => bp >= w);
        if (level !== undefined) {
          const percent = level / 100;
          push(
            finding(
              `ku_threshold_${percent}`,
              "W",
              "KU-01",
              "steuern",
              `Kleinunternehmergrenze zu ${percent} % erreicht (${formatEuro(after)} von ${formatEuro(limit)}).`,
              { params: { percent, amount: formatEuro(after), limit: formatEuro(limit) } },
            ),
          );
        }
      }
    }
  }
  // UST-24, DOC-45, EC-056: margin schemes and travel services are blocked even with a tax-case override.
  if (draft.marginScheme && resolved.derivation.kind !== "blocked") {
    push(
      finding(
        "margin_scheme_blocked",
        "E",
        "UST-24",
        "steuern",
        "Differenzbesteuerung und Reiseleistungen (§§ 25, 25a UStG) werden in dieser Version nicht unterstützt. Bitte mit einem Steuerberater abstimmen.",
        { field: "marginScheme" },
      ),
    );
  }
  // UVA-07, TAX-017, DOC-45, EC-057: EU-wide OSS threshold (P1 block; destination taxation is P4).
  if (isInvoice) {
    const thisOss = ossNetEurCentsOf(draft, ctx, resolved);
    const block = ossBlock({
      thisNetEurCents: thisOss,
      priorYearEurCents: ctx.ossTurnover?.priorYearEurCents ?? 0,
      currentYearEurCents: ctx.ossTurnover?.currentYearEurCents ?? 0,
      date: (range?.to ?? docDate) as CalendarDate,
    });
    if (block) {
      push(finding(block.code, "E", "UVA-07", "steuern", block.message, { field: "contactId", params: block.params }));
    }
  }
  // DOC-23: goods leaving Germany need the delivery address (the destination country drives the tax case, EC-042).
  if (isInvoice && (taxCase === "intra_community_supply" || taxCase === "export") && !draft.deliveryAddress) {
    push(
      finding(
        "delivery_address_missing",
        "E",
        "DOC-23",
        "pflichtangaben",
        "Lieferadresse fehlt. Bei innergemeinschaftlichen Lieferungen und Ausfuhren ist die Lieferanschrift Pflicht.",
        { field: "deliveryAddress" },
      ),
    );
  }
  if (c && (taxCase === "eu_b2b_service" || taxCase === "intra_community_supply")) {
    const label = TAX_CASE_LABELS[taxCase];
    const vatId = c.vatId;
    if (!vatId) {
      push(
        finding(
          "buyer_vat_id_missing",
          "E",
          "UST-20",
          "steuern",
          `Die USt-IdNr. des Kunden fehlt (Pflicht bei ${label}).`,
          { field: "contactId", params: { taxCaseLabel: label } },
        ),
      );
    } else if (vatId.startsWith("DE")) {
      push(
        finding(
          "buyer_vat_id_domestic",
          "E",
          "UST-20",
          "steuern",
          "Für innergemeinschaftliche Umsätze muss die USt-IdNr. aus einem anderen EU-Mitgliedstaat stammen.",
          {
            field: "contactId",
          },
        ),
      );
    } else if (!validateVatId(vatId).ok) {
      push(
        finding(
          "buyer_vat_id_invalid_format",
          "E",
          "UST-20",
          "steuern",
          `Die USt-IdNr. ${vatId} hat ein ungültiges Format.`,
          { field: "contactId", params: { vatId } },
        ),
      );
    } else {
      const gate = vatCheckGate({
        taxCase,
        vatId,
        isEuPrefixOnSupplyDate: isEuVatPrefix(vatId.slice(0, 2), (range?.to ?? docDate) as CalendarDate),
        checks: c.vatChecks,
        today,
        recheckDone: true,
      });
      if (gate.kind === "blocked" && gate.overridable && opts.vatCheckOverride) {
        overriddenVatCheck = { vatId, qualifiedRequired: taxCase === "intra_community_supply" };
      }
      if (gate.kind === "blocked" && !(gate.overridable && opts.vatCheckOverride)) {
        const mismatch = gate.code === "VAT_CHECK_NOT_QUALIFIED" && c.vatChecks[0]?.qualified !== undefined;
        push(
          finding(
            mismatch ? "buyer_vat_id_qualified_mismatch" : "buyer_vat_id_not_verified",
            "E",
            "MISC-04",
            "steuern",
            mismatch
              ? "Die qualifizierte Bestätigung weicht ab. Der Vertrauensschutz für die steuerfreie Lieferung ist gefährdet. Freigabe nur mit Begründung."
              : `USt-IdNr. ${vatId} ist nicht bestätigt. Bitte jetzt prüfen oder mit Begründung freigeben (die Prüfung wird nachgeholt).`,
            { field: "contactId", params: { vatId }, overridable: gate.overridable },
          ),
        );
      } else if (gate.kind === "ok_with_warning") {
        push(finding("buyer_vat_id_check_old", "W", "MISC-04", "steuern", gate.warning, { field: "contactId" }));
      }
      const last = c.vatChecks.find((x) => x.vatId === vatId && x.status === "valid");
      if (last && last.checkedOn < addDays(today, -90)) {
        push(
          finding(
            "buyer_vat_id_check_old",
            "W",
            "MISC-04",
            "steuern",
            `Letzte USt-IdNr.-Prüfung am ${de(last.checkedOn)}. Bitte erneut prüfen.`,
            {
              field: "contactId",
              params: { date: last.checkedOn },
            },
          ),
        );
      }
    }
  }
  if (
    c &&
    !c.isConsumer &&
    !c.vatId &&
    c.countryCode !== "DE" &&
    isEuVatCountry(c.countryCode, today) &&
    taxCase === "domestic"
  ) {
    push(
      finding(
        "no_vat_id_foreign_business",
        "W",
        "UST-20",
        "steuern",
        "Keine USt-IdNr. hinterlegt – die Leistung wird mit deutscher Umsatzsteuer abgerechnet. USt-IdNr. jetzt prüfen?",
        { field: "contactId" },
      ),
    );
  }
  const deliveryCountry = draft.deliveryAddress?.countryCode ?? c?.countryCode;
  if (
    taxCase === "intra_community_supply" &&
    deliveryCountry &&
    (deliveryCountry === "DE" || !isEuVatCountry(deliveryCountry, today)) &&
    deliveryCountry !== "XI"
  ) {
    push(
      finding(
        "igl_delivery_country_invalid",
        "E",
        "UST-21",
        "steuern",
        "Innergemeinschaftliche Lieferung: Die Lieferadresse muss in einem anderen EU-Mitgliedstaat liegen.",
        { field: "deliveryAddress" },
      ),
    );
  }
  if (taxCase === "export" && deliveryCountry && (deliveryCountry === "XI" || isEuVatCountry(deliveryCountry, today))) {
    push(
      finding(
        "export_delivery_country_invalid",
        "E",
        "UST-23",
        "steuern",
        "Ausfuhrlieferung: Die Lieferadresse muss außerhalb der EU liegen.",
        { field: "deliveryAddress" },
      ),
    );
  }
  if (taxCase === "intra_community_supply" && draft.lines.some((l) => l.kind === "item" && l.productType !== "good")) {
    push(
      finding(
        "igl_services_ancillary",
        "I",
        "UST-21",
        "hinweise",
        "Dienstleistungspositionen werden als Nebenleistung zur Lieferung behandelt (steuerfrei).",
      ),
    );
  }
  const rc13bLines = resolved.lines.filter((r) => r.vatCategory === "AE" && draft.lines[r.index]?.reverseCharge13b);
  if (c && rc13bLines.length > 0) {
    const needsCert = rc13bLines.some((r) =>
      ["construction", "cleaning"].includes(draft.lines[r.index]?.reverseCharge13b ?? ""),
    );
    if (needsCert && !opts.rc13bConfirmed) {
      const gate = certificateGate(c.certificates13b, range?.to ?? docDate);
      if (gate.kind === "needs_confirmation") {
        push(
          finding("rc13b_certificate_missing", "W", "UST-22", "steuern", gate.message, {
            field: "contactId",
            params: { contact: c.buyer.name },
          }),
        );
      }
    }
  }
  if (c && cats.has("AE") && einvoice.format !== "none" && !c.buyer.vatId && !c.buyer.registerNumber) {
    push(
      finding(
        "rc_buyer_id_missing_xml",
        "E",
        "UST-22",
        "e_rechnung",
        "Für die E-Rechnung mit Steuerschuldnerschaft des Leistungsempfängers ist die USt-IdNr. oder die Handelsregisternummer des Kunden erforderlich.",
        { field: "contactId" },
      ),
    );
  }
  if (cats.has("O") && cats.size > 1) {
    push(
      finding(
        "category_o_mixed",
        "E",
        "UST-23",
        "steuern",
        "„Nicht im Inland steuerbar“ kann nicht mit anderen Steuerkategorien in einem Dokument kombiniert werden.",
        {
          field: "lines",
        },
      ),
    );
  }

  // ── §5.1.5 currency ─────────────────────────────────────────────────────────────────────────────────────────
  if (!isSupportedCurrency(draft.currency)) {
    push(
      finding(
        "currency_unsupported",
        "E",
        "MISC-08",
        "pflichtangaben",
        `Die Währung ${draft.currency} wird nicht unterstützt.`,
        { field: "currency", params: { currency: draft.currency } },
      ),
    );
  } else if (draft.currency !== "EUR") {
    if (!draft.fxRateToEur) {
      push(
        finding(
          "fx_rate_missing",
          "E",
          "MISC-08",
          "pflichtangaben",
          "Umrechnungskurs nach EUR fehlt (Pflicht bei Fremdwährung, § 16 Abs. 6 UStG).",
          {
            field: "fxRateToEur",
          },
        ),
      );
    } else if (draft.fxRateToEur.source !== "bmf_monthly") {
      push(
        finding(
          "fx_rate_source_daily",
          "W",
          "MISC-08",
          "hinweise",
          "Tageskurs statt BMF-Monatskurs: nur mit Gestattung des Finanzamts zulässig.",
          { field: "fxRateToEur" },
        ),
      );
    }
    if (draft.showEpcQr) {
      push(
        finding(
          "epc_qr_not_eur",
          "I",
          "MISC-01",
          "hinweise",
          "Der GiroCode ist nur für Euro-Zahlungen möglich und wird weggelassen.",
          { field: "showEpcQr" },
        ),
      );
    }
  }

  // ── §5.1.7 e-invoice ────────────────────────────────────────────────────────────────────────────────────────
  if (isInvoice && (einvoice.chosenNotAllowed || (einvoice.er03.decision === "MUST_E" && einvoice.format === "none"))) {
    push(
      finding(
        "einvoice_required",
        "E",
        "ER-03",
        "e_rechnung",
        `Für diese Rechnung ist eine E-Rechnung Pflicht (${einvoice.er03.reason}). Bitte ZUGFeRD oder XRechnung wählen.`,
        {
          field: "einvoiceFormat",
          params: { reason: einvoice.er03.reason },
        },
      ),
    );
  }
  const bt10 = (draft.buyerReference ?? "").trim() || (c?.buyerReference ?? "").trim();
  // BT-10 / Leitweg-ID belongs to the e-invoice (ER-20): quotes, orders, delivery notes and proforma carry no XML.
  if (c?.isPublicAuthority && isInvoice) {
    const lw = validateLeitwegId(bt10);
    if (!lw.ok) {
      const msg =
        lw.error.code === "leitweg_id_missing"
          ? "Öffentlicher Auftraggeber: Die Leitweg-ID fehlt."
          : lw.error.code === "leitweg_id_checksum"
            ? `Die Prüfziffer der Leitweg-ID ${bt10} ist falsch.`
            : `Die Leitweg-ID ${bt10} hat ein ungültiges Format.`;
      push(finding(lw.error.code, "E", "ER-20", "e_rechnung", msg, { field: "buyerReference", params: { id: bt10 } }));
    }
  } else if (bt10 && /^\d{2,12}(-[A-Za-z0-9]{1,30})?-\d{2}$/.test(bt10) && validateLeitwegId(bt10).ok) {
    push(
      finding(
        "leitweg_id_non_public",
        "W",
        "ER-20",
        "e_rechnung",
        "Der Kunde ist nicht als öffentlicher Auftraggeber markiert, die Käuferreferenz sieht aber wie eine Leitweg-ID aus.",
        { field: "buyerReference" },
      ),
    );
  }
  if (isXRechnungFormat(einvoice.format)) {
    if (!c?.isPublicAuthority && !bt10) {
      push(
        finding(
          "buyer_reference_placeholder",
          "I",
          "ER-10",
          "e_rechnung",
          "Keine Käuferreferenz (BT-10) hinterlegt – es wird ein Ersatzwert verwendet.",
          {
            field: "buyerReference",
          },
        ),
      );
    }
    if (!ctx.company.seller.electronicAddress?.value) {
      push(
        finding(
          "seller_electronic_address_missing",
          "E",
          "ER-10",
          "e_rechnung",
          "Die elektronische Adresse des Unternehmens (BT-34) fehlt → Einstellungen › Unternehmen.",
          { field: "settings/company" },
        ),
      );
    }
    if (c && !c.buyer.electronicAddress && !c.buyer.invoiceEmail) {
      push(
        finding(
          "buyer_electronic_address_missing",
          "E",
          "ER-10",
          "e_rechnung",
          "Für die XRechnung fehlt eine elektronische Adresse des Kunden (E-Mail oder Leitweg-ID).",
          { field: "contactId" },
        ),
      );
    }
  }
  // ── §5.1.6 conversions: never bill a source line or a delivery note twice (QUO-10/11/13, UST-34) ──────────
  if (isInvoice) {
    const billed = new Map<string, number>();
    resolved.lines.forEach((r) => {
      const l = draft.lines[r.index];
      if (!l?.sourceLineId || l.optional) return;
      const limit = ctx.sourceLineRemaining?.[l.sourceLineId];
      if (!limit) return;
      const total = (billed.get(l.sourceLineId) ?? 0) + (l.quantityMilli ?? 0);
      billed.set(l.sourceLineId, total);
      if (total > limit.remainingMilli) {
        const remaining = formatMilli(Math.max(0, limit.remainingMilli));
        push(
          finding(
            "quantity_exceeds_source",
            "E",
            "UST-34",
            "pflichtangaben",
            `Position ${r.position}: Die Menge übersteigt die noch nicht berechnete Menge aus ${limit.sourceNumber} (noch ${remaining}).`,
            {
              field: `lines.${r.index}.quantityMilli`,
              params: { n: r.position, source: limit.sourceNumber, remaining },
            },
          ),
        );
      }
    });
    for (const dn of ctx.deliveryNotesInvoiced ?? []) {
      push(
        finding(
          "delivery_note_already_invoiced",
          "E",
          "UST-34",
          "pflichtangaben",
          `Lieferschein ${dn.number} ist bereits in Rechnung ${dn.invoiceNumber} enthalten.`,
          { params: { number: dn.number, invoice: dn.invoiceNumber } },
        ),
      );
    }
  }
  out.push(...chainFindings(draft, ctx, resolved));
  return { findings: dedupe(out), resolved, einvoice, ...(overriddenVatCheck ? { overriddenVatCheck } : {}) };
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.code}|${f.field ?? ""}|${JSON.stringify(f.params ?? {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
