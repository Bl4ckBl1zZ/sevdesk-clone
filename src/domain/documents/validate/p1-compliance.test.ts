import { BUYERS, goodLine, makeContact, makeContext, makeDraft, serviceLine } from "@test/factories/documents";
import { describe, expect, test } from "vitest";
import type { DocumentContext, DraftDocument } from "../draft";
import { validateDocument } from "./index";

const findings = (draft: DraftDocument, ctx: DocumentContext = makeContext(), opts = {}) =>
  validateDocument(draft, ctx, opts).findings;
const codes = (draft: DraftDocument, ctx: DocumentContext = makeContext(), opts = {}) =>
  findings(draft, ctx, opts).map((f) => f.code);

describe("line content (DOC-49, UST-07)", () => {
  test("DOC-49 every item line needs a Rec 20/21 unit code; generic descriptions warn with generic_description", () => {
    const noUnit = findings(makeDraft({ lines: [serviceLine({ unitCode: undefined })] }));
    expect(noUnit.find((f) => f.code === "line_unit_missing")?.severity).toBe("E");
    const badUnit = findings(makeDraft({ lines: [serviceLine({ unitCode: "STUNDEN" })] }));
    expect(badUnit.find((f) => f.code === "line_unit_invalid")?.severity).toBe("E");
    for (const name of ["Leistung", "Diverses", " Pauschale ", "SERVICE"]) {
      const f = findings(makeDraft({ lines: [serviceLine({ name })] })).find((x) => x.code === "generic_description");
      expect(f?.severity, name).toBe("W");
    }
    // a specific description and a seeded unit code pass
    expect(codes(makeDraft({ lines: [serviceLine({ name: "Webdesign Startseite", unitCode: "HUR" })] }))).not.toEqual(
      expect.arrayContaining(["line_unit_missing", "line_unit_invalid", "generic_description"]),
    );
    // headings and text lines need no unit
    expect(codes(makeDraft({ lines: [{ kind: "heading", name: "Leistungen" }, serviceLine()] }))).not.toContain(
      "line_unit_missing",
    );
  });
});

const consumerAt = () =>
  makeContact({
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
const AT_DELIVERY = {
  name: "Anna Gruber",
  street: "Hauptplatz 1",
  postalCode: "8010",
  city: "Graz",
  countryCode: "AT",
};
const day = (d: string) => d as DocumentContext["today"];
const VALID = { status: "valid" as const, qualified: true };

describe("blocked schemes (UST-24, DOC-45, EC-056/057)", () => {
  test("UST-24 DOC-45 EC-056 a declared margin scheme or travel service is blocked — also with a tax-case override", () => {
    const f = findings(makeDraft({ marginScheme: true }));
    const blocked = f.filter((x) => x.code === "margin_scheme_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      severity: "E",
      message:
        "Differenzbesteuerung und Reiseleistungen (§§ 25, 25a UStG) werden in dieser Version nicht unterstützt. Bitte mit einem Steuerberater abstimmen.",
    });
    const overridden = makeDraft({
      marginScheme: true,
      taxCaseOverride: { taxCase: "domestic", reason: "Gebrauchtwagen an Privat" },
    });
    expect(codes(overridden)).toContain("margin_scheme_blocked");
    expect(codes(makeDraft())).not.toContain("margin_scheme_blocked");
  });

  test("UVA-07 TAX-017 DOC-45 EC-057 an EU B2C distance sale that would exceed 10 000 € EU-wide is blocked", () => {
    const goods = makeDraft({
      lines: [goodLine({ quantityMilli: 1_000, unitPriceMicros: 1_000_000 })], // 100,00 € net
      deliveryAddress: AT_DELIVERY,
      priceMode: "net",
    });
    const at = (prior: number, current: number) =>
      makeContext({ contact: consumerAt(), ossTurnover: { priorYearEurCents: prior, currentYearEurCents: current } });
    expect(codes(goods, at(0, 990_000))).not.toContain("oss_threshold_exceeded"); // exactly 10 000,00 €
    const over = findings(goods, at(0, 990_001)).find((x) => x.code === "oss_threshold_exceeded");
    expect(over).toMatchObject({ severity: "E", rule: "UVA-07" });
    expect(codes(goods, at(1_000_001, 0))).toContain("oss_threshold_exceeded");
    // ordinary services to an Austrian consumer stay taxable in Germany (§ 3a Abs. 1) and are never blocked
    expect(codes(makeDraft({ lines: [serviceLine()] }), at(5_000_000, 5_000_000))).not.toContain(
      "oss_threshold_exceeded",
    );
    // the same goods to a German business are no OSS sale
    expect(
      codes(goods, makeContext({ ossTurnover: { priorYearEurCents: 5_000_000, currentYearEurCents: 0 } })),
    ).not.toContain("oss_threshold_exceeded");
  });

  test("DOC-56 the OSS threshold is evaluated in EUR with the document FX rate", () => {
    const usd = makeDraft({
      currency: "USD",
      fxRateToEur: { rate: "1.0831", source: "ecb_daily", date: "2026-10-09" },
      lines: [goodLine({ quantityMilli: 1_000, unitPriceMicros: 1_083_100 })], // 108,31 USD = 100,00 €
      deliveryAddress: AT_DELIVERY,
    });
    const ctx = (current: number) =>
      makeContext({ contact: consumerAt(), ossTurnover: { priorYearEurCents: 0, currentYearEurCents: current } });
    expect(codes(usd, ctx(990_000))).not.toContain("oss_threshold_exceeded");
    expect(codes(usd, ctx(990_001))).toContain("oss_threshold_exceeded");
  });
});

describe("§ 14a deadline (UST-02, INV-27)", () => {
  const eu = (today: string, supply: string) =>
    findings(
      makeDraft({ supplyDate: { kind: "date", date: supply }, documentDate: undefined }),
      makeContext({
        today: day(today),
        contact: makeContact({ countryCode: "AT", buyer: BUYERS.at, vatId: "ATU12345675", vatIdStatus: VALID }),
      }),
      { vatCheckOverride: true },
    ).filter((f) => f.code.startsWith("deadline_14a"));

  test("UST-02 INV-27 an EU B2B service names „bis 15. des Folgemonats“, warns from 3 days before and after the deadline", () => {
    expect(eu("2026-10-01", "2026-09-20")).toEqual([
      expect.objectContaining({
        code: "deadline_14a_info",
        severity: "I",
        message: "Rechnung bis 15.10.2026 ausstellen (§ 14a UStG).",
      }),
    ]);
    expect(eu("2026-10-11", "2026-09-20")[0]?.code).toBe("deadline_14a_info");
    expect(eu("2026-10-12", "2026-09-20")[0]).toMatchObject({
      code: "deadline_14a",
      severity: "W",
      message: "Diese Rechnung muss bis 15.10.2026 ausgestellt werden (§ 14a UStG).",
    });
    expect(eu("2026-10-16", "2026-09-20")[0]).toMatchObject({ code: "deadline_14a_missed", severity: "W" });
    // December supply → 15 January of the next year
    expect(eu("2026-12-30", "2026-12-28")[0]?.params?.date).toBe("2027-01-15");
    // domestic invoices have no § 14a deadline
    expect(findings(makeDraft()).some((f) => f.code.startsWith("deadline_14a"))).toBe(false);
  });
});

describe("delivery address (DOC-23, UST-21, UST-23)", () => {
  test("DOC-23 intra-Community supplies and exports need the delivery address; it drives the tax case", () => {
    const at = makeContact({ countryCode: "AT", buyer: BUYERS.at, vatId: "ATU12345675", vatIdStatus: VALID });
    const ctx = makeContext({ contact: at });
    const missing = findings(makeDraft({ lines: [goodLine()] }), ctx, { vatCheckOverride: true });
    expect(missing.find((f) => f.code === "delivery_address_missing")).toMatchObject({ severity: "E", rule: "DOC-23" });
    const given = validateDocument(
      makeDraft({ lines: [goodLine()], deliveryAddress: { ...AT_DELIVERY, name: "Lager Wien" } }),
      ctx,
      { vatCheckOverride: true },
    );
    expect(given.resolved.taxCase).toBe("intra_community_supply");
    expect(given.findings.map((f) => f.code)).not.toContain("delivery_address_missing");
    // a German delivery address turns the same sale into a domestic one (EC-042)
    const hamburg = { name: "Lager", street: "Hafenstraße 1", postalCode: "20457", city: "Hamburg", countryCode: "DE" };
    const de = validateDocument(makeDraft({ lines: [goodLine()], deliveryAddress: hamburg }), ctx, {
      vatCheckOverride: true,
    });
    expect(de.resolved.taxCase).toBe("domestic");
    // services need no delivery address
    expect(codes(makeDraft(), ctx, { vatCheckOverride: true })).not.toContain("delivery_address_missing");
  });
});

describe("Stichtag simulation (DOC-57, MISC-09)", () => {
  const TYPES = ["invoice", "quote", "order_confirmation", "proforma", "partial_invoice"] as const;
  const change = {
    standard: [
      {
        id: "sim",
        validFrom: day("2026-11-01"),
        value: { category: "S" as const, rateBp: 2100 },
        source: "Simulation",
      },
    ],
  };

  test.each(TYPES)("DOC-57 %s computes the old rate before and the injected one from the change date", (type) => {
    const at = (date: string) => {
      const draft = makeDraft({
        type,
        documentDate: date,
        supplyDate: { kind: "date", date },
        lines: [serviceLine({ quantityMilli: 1_000, unitPriceMicros: 1_000_000 })],
      });
      return validateDocument(draft, makeContext({ today: day("2026-11-15"), vatRateOverrides: change })).resolved;
    };
    const before = at("2026-10-31");
    const after = at("2026-11-01");
    expect(before.lines[0]?.vatRateBp).toBe(1900);
    expect(before.totals?.vatTotalCents).toBe(1_900);
    expect(after.lines[0]?.vatRateBp).toBe(2100);
    expect(after.lines[0]?.vatRuleRowId).toBe("override:sim");
    expect(after.totals?.grossCents).toBe(12_100);
  });

  test("DOC-57 a supply period across the injected change must be split", () => {
    const draft = makeDraft({ supplyDate: { kind: "period", from: "2026-10-15", to: "2026-11-15" } });
    expect(codes(draft, makeContext({ today: day("2026-11-20"), vatRateOverrides: change }))).toContain(
      "supply_period_crosses_rate_change",
    );
  });
});
