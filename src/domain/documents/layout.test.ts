import { describe, expect, test } from "vitest";
import {
  footerVisible,
  PREVIEW_SAMPLE_TYPES,
  PRINT_OPTION_KEYS,
  resolveLayoutId,
  SALES_DOC_TYPES,
  setDefaultLayout,
} from "./layout";
import { sampleDocument } from "./sample";

describe("SET-014 the footer cannot be switched off (MAIL-03)", () => {
  test("SET-014 the print options offer no footer switch — only the SET-075 letterhead confirmation", () => {
    expect(PRINT_OPTION_KEYS).not.toContain("footer");
    expect(PRINT_OPTION_KEYS.filter((k) => /footer/i.test(k))).toEqual(["allInvoiceAccountsInFooter"]);
  });

  test("SET-014 the footer is printed unless every legal-form item is confirmed for the letterhead (SET-075)", () => {
    const items = ["Firma", "Sitz", "Registergericht", "HRB", "Geschäftsführer"];
    expect(footerVisible({ footerInLetterhead: null }, items)).toBe(true);
    expect(footerVisible({ footerInLetterhead: { confirmedAt: 1, items: items.slice(0, 3) } }, items)).toBe(true);
    expect(footerVisible({ footerInLetterhead: { confirmedAt: 1, items } }, items)).toBe(false);
  });
});

describe("SET-074 default layout per document type", () => {
  const layouts = [
    { id: "std", isDefaultFor: [...SALES_DOC_TYPES] },
    { id: "angebot", isDefaultFor: [] as string[] },
  ];

  test("SET-074 a draft uses its chosen layout, otherwise the default for its type", () => {
    expect(resolveLayoutId(layouts, "quote")).toBe("std");
    expect(resolveLayoutId(layouts, "quote", "angebot")).toBe("angebot");
    // A chosen layout that no longer exists falls back to the default.
    expect(resolveLayoutId(layouts, "quote", "geloescht")).toBe("std");
    expect(resolveLayoutId([], "quote")).toBeNull();
  });

  test("SET-074 making a layout the default for types moves them away from every other layout", () => {
    const next = setDefaultLayout(layouts, "angebot", ["quote", "order_confirmation"]);
    expect(next).toEqual([
      { id: "std", isDefaultFor: SALES_DOC_TYPES.filter((t) => t !== "quote" && t !== "order_confirmation") },
      { id: "angebot", isDefaultFor: ["quote", "order_confirmation"] },
    ]);
    expect(resolveLayoutId(next, "quote")).toBe("angebot");
    expect(resolveLayoutId(next, "invoice")).toBe("std");
    // Every type keeps exactly one default.
    for (const t of SALES_DOC_TYPES) expect(next.filter((l) => l.isDefaultFor.includes(t))).toHaveLength(1);
  });
});

describe("SET-073 layout preview sample documents", () => {
  const today = "2026-10-12";

  test("SET-073 the owner can preview Rechnung, Angebot, Mahnung and Lieferschein", () => {
    expect(PREVIEW_SAMPLE_TYPES).toEqual(["invoice", "quote", "reminder", "delivery_note"]);
    expect(sampleDocument({ type: "invoice", b2b: true, ku: false, today }).title).toBe("Rechnung");
    expect(sampleDocument({ type: "quote", b2b: true, ku: false, today }).title).toBe("Angebot");
    expect(sampleDocument({ type: "reminder", b2b: true, ku: false, today }).title).toBe("Zahlungserinnerung");
    expect(sampleDocument({ type: "delivery_note", b2b: true, ku: false, today }).title).toBe("Lieferschein");
  });

  test("SET-073 B2B shows a company recipient, B2C a person; regular taxation adds 19 % VAT", () => {
    const b2b = sampleDocument({ type: "invoice", b2b: true, ku: false, today });
    expect(b2b.recipient[0]).toBe("Beispiel Kunde GmbH");
    expect(b2b.totals).toMatchObject({ netCents: 150_000, vatCents: 28_500, grossCents: 178_500 });
    expect(b2b.vatLines).toEqual([{ label: "USt 19 %", baseCents: 150_000, vatCents: 28_500 }]);
    const b2c = sampleDocument({ type: "invoice", b2b: false, ku: false, today });
    expect(b2c.recipient[0]).toBe("Erika Beispiel");
  });

  test("SET-073 KU-02 a Kleinunternehmer sample shows no VAT and the § 19 note", () => {
    const ku = sampleDocument({ type: "invoice", b2b: false, ku: true, today });
    expect(ku.totals).toMatchObject({ netCents: 150_000, vatCents: 0, grossCents: 150_000 });
    expect(ku.vatLines).toEqual([]);
    expect(ku.notes).toContain("Steuerfreie Leistung gemäß § 19 Abs. 1 UStG (Kleinunternehmerregelung).");
  });

  test("SET-073 the delivery note has no prices; every sample is marked as a sample", () => {
    const ls = sampleDocument({ type: "delivery_note", b2b: true, ku: false, today });
    expect(ls.showPrices).toBe(false);
    expect(ls.totals).toBeNull();
    expect(ls.number).toBe("LS-2026-0001 (Muster)");
    expect(sampleDocument({ type: "reminder", b2b: true, ku: false, today }).notes[0]).toMatch(/RE-2026-0001/);
  });
});
