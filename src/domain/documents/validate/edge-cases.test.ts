/**
 * F04 §5.2 regulatory edge cases that the pure validator decides (T-EC-0xx). One test per EC-DOC row; each asserts the
 * blocked/warned side and the allowed side named in the row's "Required behaviour" cell.
 */
import { BUYERS, goodLine, makeContact, makeContext, makeDraft, serviceLine, TODAY } from "@test/factories/documents";
import { makeSnapshot } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import { serializeEinvoice } from "../../einvoice/serialize";
import { buildSnapshot } from "../build-snapshot";
import type { DocumentContext, DraftDocument } from "../draft";
import { buildSnapshotInput } from "../finalize";
import type { ChainContext, OriginalContext } from "../relations";
import { validateDocument } from "./index";

const day = (d: string) => d as DocumentContext["today"];
const run = (draft: DraftDocument, ctx: DocumentContext = makeContext(), opts = {}) =>
  validateDocument(draft, ctx, opts);
const codes = (draft: DraftDocument, ctx: DocumentContext = makeContext(), opts = {}) =>
  run(draft, ctx, opts).findings.map((f) => f.code);
const errors = (draft: DraftDocument, ctx: DocumentContext = makeContext(), opts = {}) =>
  run(draft, ctx, opts)
    .findings.filter((f) => f.severity === "E")
    .map((f) => f.code);
const severityOf = (code: string, draft: DraftDocument, ctx: DocumentContext = makeContext(), opts = {}) =>
  run(draft, ctx, opts).findings.find((f) => f.code === code)?.severity;

function snapshotOf(draft: DraftDocument, ctx: DocumentContext = makeContext()) {
  const v = validateDocument(draft, ctx);
  const s = buildSnapshot(
    buildSnapshotInput(draft, ctx, v.resolved, {
      number: "RE-2026-0050",
      documentDate: v.resolved.documentDate,
      layoutVersionId: "layout-v1",
      plan: v.einvoice,
    }),
  );
  if (!s.ok) throw new Error(s.error.code);
  return s.value;
}

const KU = (patch: Partial<DocumentContext["company"]> = {}) => ({
  kleinunternehmer: [{ validFrom: "2025-01-01", isKU: true }],
  priorYearTurnover: [{ year: 2025, amountCents: 2_000_000 }],
  ...patch,
});
const atBusiness = (patch: Parameters<typeof makeContact>[0] = {}) =>
  makeContact({
    countryCode: "AT",
    buyer: BUYERS.at,
    vatId: "ATU12345675",
    vatIdStatus: { status: "valid", qualified: true },
    ...patch,
  });
const CHAIN: ChainContext = {
  rootId: "ab1",
  orderLabel: { de: "Auftrag", en: "order" },
  orderNumber: "AB-2026-0007",
  orderDate: "2026-08-03",
  index: 1,
  earlierAdvances: [],
  final: { advances: [] },
};
const ORIGINAL: OriginalContext = {
  id: "re1",
  type: "invoice",
  status: "sent",
  number: "RE-2026-0042",
  documentDate: "2026-10-01",
  currency: "EUR",
  groups: [{ category: "S", rateBp: 1900, netCents: 95_000, vatCents: 18_050 }],
  hadXml: false,
  format: "none",
  er03RefDate: "2026-10-01",
  earlierCredits: [],
  earlierCorrections: [],
  snapshot: makeSnapshot(),
};
const AT_DELIVERY = { name: "Lager Wien", street: "Hafen 1", postalCode: "1020", city: "Wien", countryCode: "AT" };
const QUALIFIED = (name: "A" | "B") => ({
  id: "chk",
  vatId: "ATU12345675",
  provider: "bzst_evatr" as const,
  status: "valid" as const,
  checkedOn: TODAY,
  qualified: { name, street: "A" as const, postalCode: "A" as const, city: "A" as const },
});

describe("F04 §5.2 dates (EC-DOC-13…18)", () => {
  test("EC-DOC-13 T-EC-013 backdating: reason beyond the window, warning beyond 6 months, previous year if open, locked period blocked", () => {
    const at = (documentDate: string, patch: Partial<DraftDocument> = {}) =>
      makeDraft({ documentDate, supplyDate: { kind: "date", date: documentDate }, ...patch });
    // within the 10-day window: no reason needed
    expect(codes(at("2026-10-02"))).not.toContain("backdate_reason_required");
    // beyond the window: reason required, with reason fine
    expect(errors(at("2026-09-30"))).toContain("backdate_reason_required");
    expect(errors(at("2026-09-30", { backdateReason: "Nachtrag zum Projektabschluss" }))).toEqual([]);
    // beyond 6 months: extra warning, still not blocking
    const old = at("2026-03-01", { backdateReason: "Rechnung vergessen" });
    expect(severityOf("backdate_over_6_months", old)).toBe("W");
    expect(errors(old)).toEqual([]);
    // previous year while the period is open: allowed
    expect(errors(at("2025-12-30", { backdateReason: "Jahresabschluss 2025" }))).toEqual([]);
    // locked period (or submitted UStVA): blocked even with a reason
    const locked = makeContext({ lockedThrough: "2025-12-31" });
    const f = run(at("2025-12-30", { backdateReason: "Jahresabschluss 2025" }), locked).findings.find(
      (x) => x.code === "backdate_period_locked",
    );
    expect(f).toMatchObject({ severity: "E", params: { period: "2025-12" } });
    expect(errors(at("2026-01-02", { backdateReason: "Januar" }), locked)).not.toContain("backdate_period_locked");
  });

  test("EC-DOC-14 T-EC-014 a document date in the future is refused for every type", () => {
    for (const type of ["invoice", "quote", "delivery_note", "proforma", "advance_invoice"] as const) {
      const f = run(makeDraft({ type, documentDate: "2026-10-13" })).findings.find(
        (x) => x.code === "document_date_future",
      );
      expect(f, type).toMatchObject({ severity: "E", message: "Das Dokumentdatum darf nicht in der Zukunft liegen." });
      expect(codes(makeDraft({ type, documentDate: TODAY }))).not.toContain("document_date_future");
    }
  });

  test("EC-DOC-15 T-EC-015 supply after the invoice date: blocked for invoice/final/correction, allowed for advance, partial, quote, proforma, order", () => {
    const future = { supplyDate: { kind: "date" as const, date: "2026-10-20" }, documentDate: TODAY };
    for (const type of ["invoice", "final_invoice", "correction"] as const) {
      const ctx = makeContext({ relations: { chain: CHAIN, original: ORIGINAL } });
      const patch = type === "correction" ? { correctionKind: "credit" as const } : {};
      expect(errors(makeDraft({ type, ...patch, ...future }), ctx), type).toContain("supply_date_in_future");
    }
    for (const type of ["advance_invoice", "partial_invoice", "quote", "proforma", "order_confirmation"] as const) {
      expect(codes(makeDraft({ type, ...future })), type).not.toContain("supply_date_in_future");
    }
    // the correction of an advance keeps the advance's expected supply date
    const ofAdvance = makeContext({ relations: { original: { ...ORIGINAL, type: "advance_invoice" } } });
    expect(codes(makeDraft({ type: "correction", correctionKind: "credit", ...future }), ofAdvance)).not.toContain(
      "supply_date_in_future",
    );
    // a period that starts on or before the date and ends later is info only
    const running = makeDraft({ supplyDate: { kind: "period", from: "2026-10-01", to: "2026-10-31" } });
    expect(severityOf("supply_period_ends_after_date", running)).toBe("I");
    expect(errors(running)).toEqual([]);
  });

  test("EC-DOC-16 T-EC-016 a line period across the 2026 catering rate change is blocked until split; each part gets its own rate", () => {
    const period = { kind: "period" as const, from: "2025-12-15", to: "2026-01-15" };
    const one = makeDraft({
      supplyDate: period,
      lines: [serviceLine({ name: "Catering", vatRateKey: "restaurant_food" })],
    });
    expect(errors(one)).toContain("supply_period_crosses_rate_change");
    const split = makeDraft({
      supplyDate: period,
      lines: [
        serviceLine({
          name: "Catering Dezember",
          vatRateKey: "restaurant_food",
          linePeriod: { from: "2025-12-15", to: "2025-12-31" },
        }),
        serviceLine({
          name: "Catering Januar",
          vatRateKey: "restaurant_food",
          linePeriod: { from: "2026-01-01", to: "2026-01-15" },
        }),
      ],
    });
    const r = run(split);
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
    expect(r.resolved.lines.map((l) => l.vatRateBp)).toEqual([1900, 700]);
    expect(r.resolved.totals?.groups.map((g) => g.rateBp).sort()).toEqual([1900, 700]);
  });

  test("EC-DOC-17 T-EC-017 a supply period across a KU status change is blocked", () => {
    const ctx = makeContext(
      {},
      KU({
        kleinunternehmer: [
          { validFrom: "2025-01-01", isKU: true },
          { validFrom: "2026-07-01", isKU: false },
        ],
      }),
    );
    const f = run(makeDraft({ supplyDate: { kind: "period", from: "2026-06-15", to: "2026-07-15" } }), ctx).findings;
    expect(f.find((x) => x.code === "supply_period_crosses_ku_change")).toMatchObject({
      severity: "E",
      params: { date: "2026-07-01" },
    });
    expect(
      codes(makeDraft({ supplyDate: { kind: "period", from: "2026-07-01", to: "2026-07-15" } }), ctx),
    ).not.toContain("supply_period_crosses_ku_change");
  });

  test("EC-DOC-18 T-EC-018 a supply older than 6 months may still be invoiced now, with a warning", () => {
    const old = makeDraft({ supplyDate: { kind: "date", date: "2026-03-01" } });
    expect(severityOf("supply_older_than_6_months", old)).toBe("W");
    expect(errors(old)).toEqual([]);
    expect(codes(makeDraft({ supplyDate: { kind: "date", date: "2026-05-01" } }))).not.toContain(
      "supply_older_than_6_months",
    );
  });

  test("EC-DOC-105 T-EC-105 a month supply with a rate change on the 15th is treated like a period: blocked until split", () => {
    const change = {
      standard: [
        { id: "mid", validFrom: day("2026-01-15"), value: { category: "S" as const, rateBp: 2100 }, source: "Test" },
      ],
    };
    const ctx = makeContext({ vatRateOverrides: change });
    expect(errors(makeDraft({ supplyDate: { kind: "month", month: "2026-01" } }), ctx)).toContain(
      "supply_period_crosses_rate_change",
    );
    const split = makeDraft({
      supplyDate: { kind: "month", month: "2026-01" },
      lines: [
        serviceLine({ linePeriod: { from: "2026-01-01", to: "2026-01-14" } }),
        serviceLine({ linePeriod: { from: "2026-01-15", to: "2026-01-31" } }),
      ],
    });
    const r = run(split, ctx);
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
    expect(r.resolved.lines.map((l) => l.vatRateBp)).toEqual([1900, 2100]);
  });
});

describe("F04 §5.2 Kleinunternehmer (EC-DOC-22…25, 107)", () => {
  test("EC-DOC-22 T-EC-022 the document crossing 100.000 € is blocked; after the status switch it is re-derived with VAT as a whole", () => {
    const draft = makeDraft({
      lines: [serviceLine(), serviceLine({ name: "Hosting", quantityMilli: 1_000, unitPriceMicros: 200_000 })],
    });
    const blocked = run(draft, makeContext({ kuYearTurnoverCents: 9_950_000 }, KU()));
    const crossed = blocked.findings.find((f) => f.code === "ku_threshold_crossed");
    expect(crossed?.severity).toBe("E");
    expect(String(crossed?.params?.limit)).toMatch(/^100\.000,00\s€$/);
    // "Steuerstatus jetzt umstellen" appends regular taxation from this supply date (SET-035)
    const switched = makeContext(
      { kuYearTurnoverCents: 9_950_000 },
      KU({
        kleinunternehmer: [
          { validFrom: "2025-01-01", isKU: true },
          { validFrom: "2026-10-09", isKU: false },
        ],
      }),
    );
    const r = run(draft, switched);
    expect(r.resolved.kleinunternehmer).toBe(false);
    expect(r.resolved.taxCase).toBe("domestic");
    expect(r.resolved.lines.map((l) => l.vatCategory)).toEqual(["S", "S"]); // never half KU
    expect(r.resolved.totals?.vatTotalCents).toBe(18_430);
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
  });

  test("EC-DOC-23 T-EC-023 a founding-year KU company is blocked above 25.000 €", () => {
    const draft = makeDraft(); // 950,00 € without VAT
    const founding = makeContext(
      { kuYearTurnoverCents: 2_410_000 },
      KU({ foundedOn: "2026-02-01", priorYearTurnover: [] }),
    );
    const crossed = run(draft, founding).findings.find((f) => f.code === "ku_threshold_crossed");
    expect(crossed?.severity).toBe("E");
    expect(String(crossed?.params?.limit)).toMatch(/^25\.000,00\s€$/);
    expect(
      codes(draft, makeContext({ kuYearTurnoverCents: 2_400_000 }, KU({ foundedOn: "2026-02-01" }))),
    ).not.toContain("ku_threshold_crossed");
    // the same turnover in a later year stays below the 100.000 € limit
    expect(
      codes(draft, makeContext({ kuYearTurnoverCents: 2_410_000 }, KU({ foundedOn: "2024-02-01" }))),
    ).not.toContain("ku_threshold_crossed");
  });

  test("EC-DOC-24 T-EC-024 a KU company cannot set a VAT category on any channel (no override path)", () => {
    const ctx = makeContext({}, KU());
    for (const cat of ["S", "Z"] as const) {
      const f = run(makeDraft({ lines: [serviceLine({ vatCategoryOverride: cat })] }), ctx).findings;
      expect(f.find((x) => x.code === "ku_vat_not_allowed")?.severity, cat).toBe("E");
    }
    const plain = run(makeDraft(), ctx);
    expect(plain.resolved.lines[0]?.vatCategory).toBe("KU");
    expect(plain.findings.map((f) => f.code)).not.toContain("ku_vat_not_allowed");
  });

  test("EC-DOC-25 T-EC-025 prior-year turnover above 25.000 € blocks KU invoices even though the history still says KU", () => {
    const over = makeContext({}, KU({ priorYearTurnover: [{ year: 2025, amountCents: 2_500_001 }] }));
    const f = run(makeDraft(), over).findings.find((x) => x.code === "ku_status_outdated");
    expect(f).toMatchObject({ severity: "E", params: { year: 2026 } });
    const exact = makeContext({}, KU({ priorYearTurnover: [{ year: 2025, amountCents: 2_500_000 }] }));
    expect(codes(makeDraft(), exact)).not.toContain("ku_status_outdated");
  });

  test("EC-DOC-107 T-EC-107 an advance invoice of a KU company is allowed without VAT", () => {
    const r = run(
      makeDraft({ type: "advance_invoice", supplyDate: { kind: "date", date: "2026-11-30" } }),
      makeContext({ relations: { chain: CHAIN } }, KU()),
    );
    expect(r.resolved.taxCase).toBe("kleinunternehmer");
    expect(r.resolved.lines[0]?.vatCategory).toBe("KU");
    expect(r.resolved.totals?.vatTotalCents).toBe(0);
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
  });
});

describe("F04 §5.2 VAT IDs and place of supply (EC-DOC-27…34, 108)", () => {
  test("EC-DOC-27 T-EC-027 an EU business without VAT ID buying a service pays German VAT; overriding to eu_b2b_service is blocked", () => {
    const ctx = makeContext({ contact: atBusiness({ vatId: undefined, buyer: { ...BUYERS.at, vatId: undefined } }) });
    const r = run(makeDraft(), ctx);
    expect(r.resolved.taxCase).toBe("domestic");
    expect(r.resolved.lines[0]).toMatchObject({ vatCategory: "S", vatRateBp: 1900 });
    expect(r.findings.find((f) => f.code === "no_vat_id_foreign_business")?.severity).toBe("W");
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
    const forced = makeDraft({ taxCaseOverride: { taxCase: "eu_b2b_service", reason: "Kunde sagt Reverse Charge" } });
    expect(errors(forced, ctx)).toContain("buyer_vat_id_missing");
  });

  test("EC-DOC-28 T-EC-028 an invalid VAT ID (format, check digit, VIES invalid) blocks K/AE", () => {
    const eu = { taxCaseOverride: { taxCase: "eu_b2b_service" as const, reason: "EU-Dienstleistung B2B" } };
    expect(errors(makeDraft(eu), makeContext({ contact: atBusiness({ vatId: "ATU123" }) }))).toContain(
      "buyer_vat_id_invalid_format",
    );
    // LEGAL-OPEN: offline check digits are verified for DE IDs only; a foreign ID with a wrong check digit is caught
    // by the mandatory VIES/eVatR check below (status invalid).
    const viesInvalid = makeContext({
      contact: atBusiness({
        vatChecks: [{ id: "c", vatId: "ATU12345675", provider: "eu_vies", status: "invalid", checkedOn: TODAY }],
      }),
    });
    const f = run(makeDraft(eu), viesInvalid).findings.find((x) => x.code === "buyer_vat_id_not_verified");
    expect(f?.severity).toBe("E");
    expect(f?.overridable ?? false).toBe(false);
    // an invalid result cannot be released by the override
    expect(errors(makeDraft(eu), viesInvalid, { vatCheckOverride: true })).toContain("buyer_vat_id_not_verified");
  });

  test("EC-DOC-29 T-EC-029 VIES unavailable at finalisation: K/AE blocked unless released with reason, then followed up", () => {
    // the last good check is older than 90 days; the re-check at finalisation found VIES unavailable
    const ctx = makeContext({
      contact: atBusiness({
        vatIdStatus: { status: "valid", qualified: false },
        vatChecks: [
          { id: "c2", vatId: "ATU12345675", provider: "eu_vies", status: "unavailable", checkedOn: TODAY },
          { id: "c1", vatId: "ATU12345675", provider: "eu_vies", status: "valid", checkedOn: day("2026-05-02") },
        ],
      }),
    });
    const blocked = run(makeDraft(), ctx);
    expect(blocked.resolved.taxCase).toBe("eu_b2b_service");
    expect(blocked.findings.find((f) => f.code === "buyer_vat_id_not_verified")).toMatchObject({
      severity: "E",
      overridable: true,
    });
    const released = run(makeDraft(), ctx, { vatCheckOverride: true });
    expect(released.findings.filter((f) => f.severity === "E")).toEqual([]);
    // the follow-up task "USt-IdNr nachprüfen" (RI-16) is created from this marker at commit
    expect(released.overriddenVatCheck).toEqual({ vatId: "ATU12345675", qualifiedRequired: false });
  });

  test("EC-DOC-30 T-EC-030 a qualified check with B for the name blocks an intra-Community supply unless released with reason", () => {
    const ctx = makeContext({ contact: atBusiness({ vatChecks: [QUALIFIED("B")] }) });
    const draft = makeDraft({ lines: [goodLine()], deliveryAddress: AT_DELIVERY });
    const r = run(draft, ctx);
    expect(r.resolved.taxCase).toBe("intra_community_supply");
    expect(r.findings.find((f) => f.code === "buyer_vat_id_qualified_mismatch")).toMatchObject({
      severity: "E",
      overridable: true,
    });
    const released = run(draft, ctx, { vatCheckOverride: true });
    expect(released.findings.map((f) => f.code)).not.toContain("buyer_vat_id_qualified_mismatch");
    expect(released.overriddenVatCheck).toEqual({ vatId: "ATU12345675", qualifiedRequired: true });
    expect(errors(draft, makeContext({ contact: atBusiness({ vatChecks: [QUALIFIED("A")] }) }))).toEqual([]);
  });

  test("EC-DOC-31 T-EC-031 a German VAT ID used for an EU case is refused", () => {
    const f = run(
      makeDraft({ taxCaseOverride: { taxCase: "eu_b2b_service", reason: "Reverse Charge laut Kunde" } }),
    ).findings.find((x) => x.code === "buyer_vat_id_domestic");
    expect(f?.severity).toBe("E");
    expect(f?.message).toBe(
      "Für innergemeinschaftliche Umsätze muss die USt-IdNr. aus einem anderen EU-Mitgliedstaat stammen.",
    );
  });

  test("EC-DOC-32 T-EC-032 goods to an EU VAT ID but delivered within Germany are domestic; an IGL override is refused", () => {
    const de = { name: "Lager", street: "Hafenstraße 1", postalCode: "20457", city: "Hamburg", countryCode: "DE" };
    const ctx = makeContext({ contact: atBusiness({ vatChecks: [QUALIFIED("A")] }) });
    const r = run(makeDraft({ lines: [goodLine()], deliveryAddress: de }), ctx);
    expect(r.resolved.taxCase).toBe("domestic");
    expect(r.resolved.lines[0]).toMatchObject({ vatCategory: "S", vatRateBp: 1900 });
    const forced = makeDraft({
      lines: [goodLine()],
      deliveryAddress: de,
      taxCaseOverride: { taxCase: "intra_community_supply", reason: "Kunde besteht auf IGL" },
    });
    expect(errors(forced, ctx)).toContain("igl_delivery_country_invalid");
  });

  test("EC-DOC-33 T-EC-033 Northern Ireland: goods to an XI VAT ID follow EU rules (K); services to GB/XI businesses are third-country (O)", () => {
    const ni = makeContact({
      countryCode: "XI",
      vatId: "XI123456782",
      vatIdStatus: { status: "valid", qualified: true },
      vatChecks: [
        {
          id: "x",
          vatId: "XI123456782",
          provider: "bzst_evatr",
          status: "valid",
          checkedOn: TODAY,
          qualified: { name: "A", street: "A", postalCode: "A", city: "A" },
        },
      ],
      buyer: {
        name: "Belfast Tools Ltd",
        address: { street: "1 Queen Street", postalCode: "BT1 6EA", city: "Belfast", countryCode: "XI" },
        vatId: "XI123456782",
        isConsumer: false,
        isPublicAuthority: false,
      },
    });
    const goods = run(
      makeDraft({
        lines: [goodLine()],
        deliveryAddress: {
          name: "Belfast Tools",
          street: "1 Queen Street",
          postalCode: "BT1 6EA",
          city: "Belfast",
          countryCode: "XI",
        },
      }),
      makeContext({ contact: ni }),
    );
    expect(goods.resolved.taxCase).toBe("intra_community_supply");
    expect(goods.resolved.lines[0]?.vatCategory).toBe("K");
    const services = run(makeDraft(), makeContext({ contact: ni }));
    expect(services.resolved.taxCase).toBe("not_taxable_domestic");
    expect(services.resolved.lines[0]?.vatCategory).toBe("O");
    const gb = makeContact({
      countryCode: "GB",
      vatId: undefined,
      buyer: {
        name: "London Ltd",
        address: { street: "1 Strand", postalCode: "WC2N 5HR", city: "London", countryCode: "GB" },
        isConsumer: false,
        isPublicAuthority: false,
      },
    });
    expect(run(makeDraft(), makeContext({ contact: gb })).resolved.lines[0]?.vatCategory).toBe("O");
  });

  test("EC-DOC-34 T-EC-034 a Swiss customer with a German place of supply pays German VAT; an unknown place-of-supply rule is ambiguous", () => {
    const ch = makeContact({ countryCode: "CH", buyer: BUYERS.ch, vatId: undefined });
    for (const rule of ["event_admission", "property"]) {
      const r = run(makeDraft({ lines: [serviceLine({ placeOfSupplyRule: rule })] }), makeContext({ contact: ch }));
      expect(r.resolved.taxCase, rule).toBe("domestic");
      expect(r.resolved.lines[0], rule).toMatchObject({ vatCategory: "S", vatRateBp: 1900 });
      expect(
        r.findings.filter((f) => f.severity === "E"),
        rule,
      ).toEqual([]);
    }
    const unknown = run(
      makeDraft({ lines: [serviceLine({ name: "Messestand", placeOfSupplyRule: "trade_fair" })] }),
      makeContext({ contact: ch }),
    ).findings.find((f) => f.code === "place_of_supply_ambiguous");
    expect(unknown).toMatchObject({ severity: "E", rule: "UST-23", field: "lines.0.placeOfSupplyRule" });
    expect(unknown?.message).toBe(
      "Für „Messestand“ ist der Leistungsort nicht eindeutig (z. B. Grundstück, Veranstaltung). Bitte Leistungsort-Regel wählen.",
    );
    // a general service to a Swiss business is not taxable in Germany and not ambiguous
    const general = run(makeDraft(), makeContext({ contact: ch }));
    expect(general.resolved.lines[0]?.vatCategory).toBe("O");
    expect(general.findings.map((f) => f.code)).not.toContain("place_of_supply_ambiguous");
  });

  test("EC-DOC-108 T-EC-108 a German establishment with a foreign VAT ID is taxed by the contact country, with a warning", () => {
    const establishment = makeContact({
      countryCode: "DE",
      vatId: "ATU12345675",
      buyer: { ...BUYERS.b2b, vatId: "ATU12345675" },
    });
    const r = run(makeDraft(), makeContext({ contact: establishment }));
    expect(r.resolved.taxCase).toBe("domestic");
    expect(r.resolved.lines[0]).toMatchObject({ vatCategory: "S", vatRateBp: 1900 });
    const f = r.findings.find((x) => x.code === "foreign_vat_id_domestic_establishment");
    expect(f).toMatchObject({ severity: "W", rule: "UST-20" });
    expect(f?.message).toBe(
      "Der Kunde hat eine ausländische USt-IdNr. (ATU12345675), aber eine Anschrift in Deutschland. Maßgeblich ist die Niederlassung, die die Leistung empfängt – bitte prüfen.",
    );
    expect(r.findings.filter((x) => x.severity === "E")).toEqual([]);
    expect(codes(makeDraft())).not.toContain("foreign_vat_id_domestic_establishment");
  });
});

describe("F04 §5.2 §13b, exemptions, categories (EC-DOC-35…44)", () => {
  const construction = (certificates13b: { validUntil: string; addedAt: number }[] = []) =>
    makeContext({ contact: makeContact({ buyer: BUYERS.construction, vatId: undefined, certificates13b }) });
  const bau = serviceLine({ name: "Estricharbeiten", reverseCharge13b: "construction" });

  test("EC-DOC-35 T-EC-035 §13b construction with an expired USt 1 TG warns; the owner confirms or switches to VAT", () => {
    const ctx = construction([{ validUntil: "2026-06-30", addedAt: 1 }]);
    const r = run(makeDraft({ lines: [bau] }), ctx);
    const w = r.findings.find((f) => f.code === "rc13b_certificate_missing");
    expect(w?.severity).toBe("W");
    expect(w?.message).toContain("war nur bis 30.06.2026 gültig");
    expect(r.resolved.lines[0]?.vatCategory).toBe("AE");
    expect(codes(makeDraft({ lines: [bau] }), ctx, { rc13bConfirmed: true })).not.toContain(
      "rc13b_certificate_missing",
    );
    const vat = run(makeDraft({ lines: [serviceLine({ name: "Estricharbeiten" })] }), ctx);
    expect(vat.resolved.lines[0]).toMatchObject({ vatCategory: "S", vatRateBp: 1900 });
    // a valid certificate needs no confirmation
    expect(codes(makeDraft({ lines: [bau] }), construction([{ validUntil: "2027-06-30", addedAt: 1 }]))).not.toContain(
      "rc13b_certificate_missing",
    );
  });

  test("EC-DOC-36 T-EC-036 §13b to a consumer is blocked; without the AE override the consumer is taxed normally", () => {
    const consumer = makeContext({
      contact: makeContact({ isConsumer: true, buyer: BUYERS.consumer, vatId: undefined }),
    });
    const f = run(makeDraft({ lines: [{ ...bau, vatCategoryOverride: "AE" }] }), consumer).findings;
    expect(f.find((x) => x.code === "rc13b_consumer")).toMatchObject({
      severity: "E",
      message: "§ 13b UStG setzt einen Unternehmer als Leistungsempfänger voraus.",
    });
    const derived = run(makeDraft({ lines: [bau] }), consumer);
    expect(derived.resolved.lines[0]?.vatCategory).toBe("S");
    expect(derived.findings.map((x) => x.code)).not.toContain("rc13b_consumer");
  });

  test("EC-DOC-37 T-EC-037 a §13b E-Rechnung needs the buyer's VAT ID or register number (BR-AE-02)", () => {
    const noIds = makeContext({
      contact: makeContact({
        buyer: { ...BUYERS.construction, registerNumber: undefined } as never,
        vatId: undefined,
        certificates13b: [{ validUntil: "2027-06-30", addedAt: 1 }],
      }),
    });
    const xml = run(makeDraft({ lines: [bau], einvoiceFormat: "zugferd_en16931" }), noIds);
    expect(xml.einvoice.format).toBe("zugferd_en16931");
    expect(xml.findings.find((f) => f.code === "rc_buyer_id_missing_xml")?.severity).toBe("E");
    // with the register number it is fine
    expect(
      codes(
        makeDraft({ lines: [bau], einvoiceFormat: "zugferd_en16931" }),
        construction([{ validUntil: "2027-06-30", addedAt: 1 }]),
      ),
    ).not.toContain("rc_buyer_id_missing_xml");
  });

  test("EC-DOC-38 T-EC-038 a domestic document mixing §13b metal lines and taxable lines has two groups and both texts", () => {
    const draft = makeDraft({
      lines: [
        goodLine({ name: "Kupferkabel (Anlage 3 UStG)", reverseCharge13b: "metals" }),
        serviceLine({ name: "Montage" }),
      ],
      einvoiceFormat: "zugferd_en16931",
    });
    const ctx = makeContext({ contact: makeContact({ buyer: BUYERS.construction }) });
    const r = run(draft, ctx);
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
    expect(r.resolved.taxCase).toBe("domestic");
    expect(r.resolved.lines.map((l) => l.vatCategory)).toEqual(["AE", "S"]);
    const s = snapshotOf(draft, ctx);
    expect(s.totals.byGroup.map((g) => g.category).sort()).toEqual(["AE", "S"]);
    const notes = s.notes.map((n) => n.de).join("\n");
    expect(notes).toContain("Steuerschuldnerschaft des Leistungsempfängers");
    const xml = serializeEinvoice(s, "zugferd_en16931").xml;
    expect(xml.match(/<ram:CategoryCode>AE<\/ram:CategoryCode>/g)?.length).toBeGreaterThanOrEqual(2);
    expect(xml).toContain("<ram:CategoryCode>S</ram:CategoryCode>");
  });

  test("EC-DOC-39 T-EC-039 taxable plus exempt (§ 4 Nr. 14) lines are allowed; the E group carries the exemption text", () => {
    const draft = makeDraft({
      lines: [
        serviceLine({ name: "Kosmetische Behandlung" }),
        serviceLine({ name: "Physiotherapie", vatRateKey: "exempt", exemptionReasonCode: "VATEX-EU-132-1C" }),
      ],
    });
    const r = run(draft);
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
    expect(r.resolved.lines.map((l) => l.vatCategory)).toEqual(["S", "E"]);
    const s = snapshotOf(draft);
    const e = s.totals.byGroup.find((g) => g.category === "E");
    expect(e?.exemptionReasonText).toContain("§ 4 Nr. 14 UStG");
    expect(s.totals.byGroup.find((g) => g.category === "S")?.vatCents).toBe(18_050);
  });

  test("EC-DOC-40 T-EC-040 O lines cannot be combined with other categories", () => {
    const ch = makeContext({ contact: makeContact({ countryCode: "CH", buyer: BUYERS.ch, vatId: undefined }) });
    expect(errors(makeDraft(), ch)).toEqual([]); // all O: fine
    expect(errors(makeDraft({ lines: [serviceLine(), serviceLine({ vatCategoryOverride: "O" })] }))).toContain(
      "category_o_mixed",
    );
    expect(errors(makeDraft({ lines: [serviceLine({ vatCategoryOverride: "O" })] }), ch)).toEqual([]);
    expect(
      run(makeDraft({ lines: [serviceLine(), serviceLine({ vatCategoryOverride: "S" })] }), ch).findings.find(
        (f) => f.code === "category_o_mixed",
      )?.severity,
    ).toBe("E");
  });

  test("EC-DOC-41 T-EC-041 a margin-scheme or travel-agency text is blocked, also with a tax-case override", () => {
    expect(errors(makeDraft({ marginScheme: true }))).toContain("margin_scheme_blocked");
    expect(
      errors(
        makeDraft({ marginScheme: true, taxCaseOverride: { taxCase: "domestic", reason: "Gebrauchtwagen regulär" } }),
      ),
    ).toContain("margin_scheme_blocked");
    expect(codes(makeDraft())).not.toContain("margin_scheme_blocked");
  });

  test("EC-DOC-42 T-EC-042 EU B2C sales above 10.000 € (current + prior year, EUR) are blocked", () => {
    const consumerAt = makeContact({
      countryCode: "AT",
      isConsumer: true,
      vatId: undefined,
      buyer: {
        name: "Anna Gruber",
        address: { street: "Hauptplatz 1", postalCode: "8010", city: "Graz", countryCode: "AT" },
        isConsumer: true,
        isPublicAuthority: false,
      },
    });
    const goods = makeDraft({
      lines: [goodLine({ quantityMilli: 1_000, unitPriceMicros: 1_000_000 })],
      deliveryAddress: { ...AT_DELIVERY, city: "Graz" },
    });
    const at = (prior: number, current: number) =>
      makeContext({ contact: consumerAt, ossTurnover: { priorYearEurCents: prior, currentYearEurCents: current } });
    expect(codes(goods, at(0, 990_000))).not.toContain("oss_threshold_exceeded");
    expect(errors(goods, at(0, 990_001))).toContain("oss_threshold_exceeded");
    expect(errors(goods, at(1_000_001, 0))).toContain("oss_threshold_exceeded"); // prior year alone
  });

  test("EC-DOC-43 T-EC-043 Kleinbetrag: 250,00 € allowed, 250,01 € or any K/AE line blocked; ER-03 exception never for §13b", () => {
    const kb = (unitPriceMicros: number, patch: Partial<DraftDocument> = {}) =>
      makeDraft({
        kleinbetrag: true,
        priceMode: "gross",
        lines: [serviceLine({ quantityMilli: 1_000, unitPriceMicros })],
        ...patch,
      });
    const exact = run(kb(2_500_000));
    expect(exact.resolved.totals?.grossCents).toBe(25_000);
    expect(exact.findings.filter((f) => f.severity === "E")).toEqual([]);
    expect(errors(kb(2_500_100))).toContain("kleinbetrag_not_allowed");
    const rc = kb(1_000_000, {
      priceMode: "net",
      lines: [serviceLine({ quantityMilli: 1_000, unitPriceMicros: 1_000_000, reverseCharge13b: "metals" })],
    });
    const rcCtx = makeContext({ contact: makeContact({ buyer: BUYERS.construction }) });
    const r = run(rc, rcCtx);
    expect(r.findings.filter((f) => f.severity === "E").map((f) => f.code)).toContain("kleinbetrag_not_allowed");
    expect(r.einvoice.er03.decision).not.toBe("NOT_REQUIRED");
  });

  test("EC-DOC-44 T-EC-044 a free item (0,00 €) is allowed, keeps its category and appears in the XML with BT-131 0.00", () => {
    const draft = makeDraft({
      lines: [
        serviceLine(),
        goodLine({ name: "Werbegeschenk Kugelschreiber", quantityMilli: 1_000, unitPriceMicros: 0 }),
      ],
      einvoiceFormat: "zugferd_en16931",
    });
    const r = run(draft);
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
    expect(r.resolved.lines[1]).toMatchObject({ vatCategory: "S", vatRateBp: 1900 });
    const xml = serializeEinvoice(snapshotOf(draft), "zugferd_en16931").xml;
    expect(xml).toContain("Werbegeschenk Kugelschreiber");
    expect(xml).toContain("<ram:LineTotalAmount>0.00</ram:LineTotalAmount>");
  });
});

describe("F04 §5.2 amounts (EC-DOC-46…54, 104)", () => {
  test("EC-DOC-46 T-EC-046 a 0-€ standard invoice is allowed with total_zero", () => {
    const zero = makeDraft({ lines: [serviceLine({ unitPriceMicros: 0 })] });
    const r = run(zero);
    expect(r.findings.find((f) => f.code === "total_zero")?.severity).toBe("W");
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
    expect(r.resolved.totals?.payableCents).toBe(0);
  });

  test("EC-DOC-47 T-EC-047 negative gross is blocked for invoice types and proforma; only corrections carry negative totals", () => {
    const negative = { lines: [serviceLine({ quantityMilli: -1_000 })] };
    for (const type of ["invoice", "advance_invoice", "partial_invoice", "final_invoice", "proforma"] as const) {
      expect(errors(makeDraft({ type, ...negative })), type).toContain("total_negative");
    }
    expect(codes(makeDraft({ type: "quote", ...negative }))).not.toContain("total_negative");
  });

  test("EC-DOC-48 T-EC-048 a single negative line (deposit return) is allowed with negative_line while the gross stays ≥ 0", () => {
    const deposit = makeDraft({
      lines: [serviceLine(), serviceLine({ name: "Pfandrückgabe", quantityMilli: -1_000, unitPriceMicros: 100_000 })],
    });
    const r = run(deposit);
    expect(r.findings.find((f) => f.code === "negative_line")).toMatchObject({ severity: "W", params: { n: 2 } });
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
    const tooMuch = makeDraft({
      lines: [
        serviceLine(),
        serviceLine({ name: "Pfandrückgabe", quantityMilli: -1_000, unitPriceMicros: 10_000_000 }),
      ],
    });
    expect(errors(tooMuch)).toContain("total_negative");
  });

  test("EC-DOC-53 T-EC-053 a foreign-currency invoice without FX rate is blocked; an ECB rate is accepted with a warning and its source stored", () => {
    expect(errors(makeDraft({ currency: "USD" }))).toContain("fx_rate_missing");
    const ecb = makeDraft({
      currency: "USD",
      fxRateToEur: { rate: "1.0831", source: "ecb_daily", date: "2026-10-09" },
    });
    expect(severityOf("fx_rate_source_daily", ecb)).toBe("W");
    expect(errors(ecb)).toEqual([]);
    expect(snapshotOf(ecb).fx).toMatchObject({ rate: "1.0831", source: "ecb_daily", date: "2026-10-09" });
    const bmf = makeDraft({
      currency: "USD",
      fxRateToEur: { rate: "1.0831", source: "bmf_monthly", date: "2026-10-01" },
    });
    expect(codes(bmf)).not.toContain("fx_rate_source_daily");
  });

  test("EC-DOC-54 T-EC-054 currencies with 0 or 3 minor units (JPY, KWD) are refused", () => {
    for (const currency of ["JPY", "KWD"]) {
      expect(errors(makeDraft({ currency })), currency).toContain("currency_unsupported");
    }
    expect(
      codes(makeDraft({ currency: "CHF", fxRateToEur: { rate: "0.94", source: "bmf_monthly", date: "2026-10-01" } })),
    ).not.toContain("currency_unsupported");
  });

  test("EC-DOC-104 T-EC-104 a line of 10^6 units × 10^7 € is computed exactly and refused with amount_too_large", () => {
    const huge = makeDraft({
      lines: [serviceLine({ quantityMilli: 1_000_000_000, unitPriceMicros: 100_000_000_000 })],
    });
    const r = run(huge);
    expect(r.findings.find((f) => f.code === "amount_too_large")).toMatchObject({ severity: "E", rule: "GOBD-03" });
    // 10^6 units × 84.033,6134 €: the product exceeds 2^53 micros-milli, yet the cents are exact (BigInt), below the limit
    const big = run(
      makeDraft({ lines: [serviceLine({ quantityMilli: 1_000_000_000, unitPriceMicros: 840_336_134 })] }),
    );
    expect(big.resolved.totals?.taxExclusiveCents).toBe(8_403_361_340_000);
    expect(big.resolved.totals?.vatTotalCents).toBe(1_596_638_654_600);
    expect(big.findings.map((f) => f.code)).not.toContain("amount_too_large");
  });
});

describe("F04 §5.2 texts, alerts, terms, contacts (EC-DOC-78, 79, 99…101, 106)", () => {
  test("EC-DOC-78 T-EC-078 missing seller phone/e-mail/electronic address blocks E formats only", () => {
    const missingContact = makeContext(
      {},
      { validation: { blocking: [{ code: "contact_missing", message: "Telefon fehlt" }], warnings: [] } },
    );
    expect(errors(makeDraft({ einvoiceFormat: "zugferd_en16931" }), missingContact)).toContain(
      "seller_contact_missing",
    );
    expect(codes(makeDraft({ einvoiceFormat: "none" }), missingContact)).not.toContain("seller_contact_missing");
    const noAddress = makeContext({}, { seller: { ...makeContext().company.seller, electronicAddress: undefined } });
    expect(errors(makeDraft({ einvoiceFormat: "xrechnung_cii" }), noAddress)).toContain(
      "seller_electronic_address_missing",
    );
  });

  test("EC-DOC-79 T-EC-079 up to 2,000 lines are allowed; the XML carries every line and the full texts", () => {
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        serviceLine({ name: `Position ${i + 1}`, quantityMilli: 1_000, unitPriceMicros: 10_000 }),
      );
    expect(codes(makeDraft({ lines: lines(2_000) }))).not.toContain("too_many_lines");
    expect(errors(makeDraft({ lines: lines(2_001) }))).toContain("too_many_lines");
    const head = "Kopftext ".repeat(2_000);
    const draft = makeDraft({ lines: lines(1_000), headText: head, einvoiceFormat: "zugferd_en16931" });
    const xml = serializeEinvoice(snapshotOf(draft), "zugferd_en16931").xml;
    expect(xml.match(/<ram:IncludedSupplyChainTradeLineItem>/g)?.length).toBe(1_000);
    expect(xml).toContain("Position 1000");
    expect(xml).toContain(head.trim());
    expect(errors(makeDraft({ headText: "x".repeat(20_001) }))).toContain("text_too_long");
  });

  test("EC-DOC-99 T-EC-099 an unknown placeholder in a draft text blocks finalisation", () => {
    const f = run(makeDraft({ headText: "<p>Hallo {{contact.foo}},</p>" })).findings.find(
      (x) => x.code === "placeholder_unknown",
    );
    expect(f).toMatchObject({ severity: "E", field: "headText", params: { name: "contact.foo" } });
    expect(f?.message).toBe("Unbekannter Platzhalter {{contact.foo}}.");
    expect(errors(makeDraft({ subject: "Rechnung {{document.nummer}}" }))).toContain("placeholder_unknown");
    expect(errors(makeDraft({ footText: "{{document.foo}}" }))).toContain("placeholder_unknown");
    expect(errors(makeDraft({ lines: [serviceLine({ name: "Wartung {{date.monat}}" })] }))).toContain(
      "placeholder_unknown",
    );
    // known placeholders and sections are fine
    expect(
      codes(
        makeDraft({
          subject: "Rechnung {{document.number}}",
          headText: "<p>{{#contact.isConsumer}}Hallo{{/contact.isConsumer}} {{contact.name}}</p>",
        }),
      ),
    ).not.toContain("placeholder_unknown");
  });

  test("EC-DOC-100 T-EC-100 an unacknowledged integrity alert blocks every finalisation", () => {
    const ctx = makeContext({ integrityAlertOpen: true });
    for (const type of ["invoice", "quote", "delivery_note"] as const) {
      expect(errors(makeDraft({ type }), ctx), type).toContain("integrity_alert_open");
    }
    expect(codes(makeDraft())).not.toContain("integrity_alert_open");
  });

  test("EC-DOC-101 T-EC-101 payment terms above 60 days (B2B) or 30 days (public) warn", () => {
    expect(severityOf("payment_terms_long_b2b", makeDraft({ paymentTerms: { dueDays: 61 } }))).toBe("W");
    expect(codes(makeDraft({ paymentTerms: { dueDays: 60 } }))).not.toContain("payment_terms_long_b2b");
    const pub = makeContext({
      contact: makeContact({ isPublicAuthority: true, buyer: BUYERS.public, buyerReference: "04011000-1234512345-06" }),
    });
    expect(severityOf("payment_terms_long_public", makeDraft({ paymentTerms: { dueDays: 31 } }), pub)).toBe("W");
    expect(codes(makeDraft({ paymentTerms: { dueDays: 30 } }), pub)).not.toContain("payment_terms_long_public");
    expect(errors(makeDraft({ paymentTerms: { dueDays: 90 } }))).toEqual([]);
  });

  test("EC-DOC-106 T-EC-106 a draft of an archived contact can still be finalised with a warning; the snapshot is complete", () => {
    const ctx = makeContext({ contact: makeContact({ archived: true }) });
    const r = run(makeDraft(), ctx);
    expect(r.findings.find((f) => f.code === "contact_archived")).toMatchObject({
      severity: "W",
      message: "Kontakt ist archiviert.",
    });
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
    expect(snapshotOf(makeDraft(), ctx).buyer).toMatchObject({
      name: BUYERS.b2b.name,
      address: BUYERS.b2b.address,
      vatId: BUYERS.b2b.vatId,
    });
    expect(codes(makeDraft())).not.toContain("contact_archived");
  });
});
