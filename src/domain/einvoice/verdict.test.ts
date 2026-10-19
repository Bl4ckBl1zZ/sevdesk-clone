import { CII_V6, ublXml } from "@test/fixtures/einvoice-in/builders";
import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../time/calendar-date";
import { parseReceivedXml } from "./parse";
import type { ReceivedInvoice } from "./received";
import { contentFindings, faultyMessage, findingCategory, kleinbetragLimitOn, verdictOf } from "./verdict";

const LIMIT = kleinbetragLimitOn("2026-10-19" as CalendarDate);

const inv = (xml: string): ReceivedInvoice => {
  const r = parseReceivedXml(xml);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.invoice;
};

describe("E-Rechnung verdict (INB-024, EC-INB-11, EC-103)", () => {
  test("INB-024 T06-024 KoSIT rule ids map to BMF categories: Schematron → Geschäftsregel, schema → Format", () => {
    expect(findingCategory("BR-DE-17")).toBe("business_rule");
    expect(findingCategory("BR-CO-10")).toBe("business_rule");
    expect(findingCategory("PEPPOL-EN16931-R001")).toBe("business_rule");
    expect(findingCategory("cvc-complex-type.2.4.a")).toBe("format");
    expect(findingCategory("XML")).toBe("format");
  });

  test("INB-024 ER-02 a complete invoice from our own serializer has no Inhaltsfehler", () => {
    expect(contentFindings(inv(ublXml()), LIMIT)).toEqual([]);
    expect(contentFindings(inv(CII_V6), LIMIT)).toEqual([]);
  });

  test("INB-024 Inhaltsfehler: missing supplier tax id and supply date above 250 € are content findings", () => {
    const base = inv(ublXml());
    const { vatId: _v, taxNumber: _t, ...seller } = base.seller;
    const { supplyDate: _s, period: _p, ...rest } = base;
    const broken: ReceivedInvoice = {
      ...rest,
      seller,
      totals: { ...base.totals, taxInclusiveCents: 100_000 },
    };
    const f = contentFindings(broken, LIMIT);
    expect(f.map((x) => x.ruleId)).toEqual(expect.arrayContaining(["UStG-14-4-2", "UStG-14-4-6"]));
    expect(f.every((x) => x.category === "content")).toBe(true);
  });

  test("INB-024 the Kleinbetrag limit is date-effective rule data (§ 33 UStDV: 150 € until 2016, 250 € since 2017)", () => {
    expect(kleinbetragLimitOn("2016-06-30" as CalendarDate)).toBe(15_000);
    expect(LIMIT).toBe(25_000);
    const base = inv(ublXml());
    const { vatId: _v, taxNumber: _t, ...seller } = base.seller;
    const small: ReceivedInvoice = { ...base, seller, totals: { ...base.totals, taxInclusiveCents: 20_000 } };
    expect(contentFindings(small, LIMIT).map((f) => f.ruleId)).not.toContain("UStG-14-4-2");
    expect(contentFindings(small, kleinbetragLimitOn("2016-06-30" as CalendarDate)).map((f) => f.ruleId)).toContain(
      "UStG-14-4-2",
    );
  });

  test("INB-024 EC-INB-11 EC-103 worst category wins; never acceptable with findings; message names the category", () => {
    expect(verdictOf(true, [])).toEqual({ acceptable: true, category: "ok", findings: [] });
    const v = verdictOf(false, [
      { ruleId: "UStG-14-4-6", text: "x", category: "content" },
      { ruleId: "BR-DE-17", text: "y", category: "business_rule" },
    ]);
    expect(v.acceptable).toBe(false);
    expect(v.category).toBe("business_rule");
    expect(faultyMessage(v)).toBe(
      "E-Rechnung fehlerhaft (Geschäftsregelfehler): 2 Fehler. Vorsteuerabzug ggf. gefährdet – Korrektur beim Lieferanten anfordern?",
    );
    // A failed tool run without parsed findings is still never „ok“.
    expect(verdictOf(false, []).acceptable).toBe(false);
    expect(verdictOf(false, []).category).not.toBe("ok");
    expect(verdictOf(true, [{ ruleId: "XML", text: "z", category: "format" }]).category).toBe("format");
  });
});
