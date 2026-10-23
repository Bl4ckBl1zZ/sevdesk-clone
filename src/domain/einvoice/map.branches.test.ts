import { BUYERS, makeSnapshot, SELLERS } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import type { SnapshotInputItem } from "../documents/build-snapshot";
import type { DocumentSnapshot } from "../documents/snapshot";
import { mapToEn16931 } from "./map";

const item = (over: Partial<SnapshotInputItem> = {}): SnapshotInputItem => ({
  kind: "item",
  name: "Leistung",
  quantityMilli: 1_000,
  unitCode: "LS",
  unitPriceMicros: 1_000_000,
  vatCategory: "S",
  vatRateBp: 1900,
  ...over,
});
const en16931 = (s: DocumentSnapshot) => mapToEn16931(s, { profile: "en16931" });

describe("mapToEn16931 — parties and addresses (App. A.1, A.3)", () => {
  test("INV-19 BG-8 a buyer without address (Kleinbetragsrechnung, DOC-44) gets only the country", () => {
    const s = makeSnapshot();
    const inv = en16931({ ...s, buyer: { ...s.buyer, address: undefined } });
    expect(inv.buyer.address).toEqual({ countryCode: "DE" });
  });

  test("INV-19 BG-8 a PO box replaces a missing street; street2 and department become BT-51/BT-163", () => {
    const s = makeSnapshot();
    const inv = en16931({
      ...s,
      buyer: {
        ...s.buyer,
        address: {
          street: "",
          poBox: "Postfach 10 20 30",
          street2: "Gebäude B",
          department: "Einkauf",
          postalCode: "50667",
          city: "Köln",
          countryCode: "DE",
        },
      },
    });
    expect(inv.buyer.address).toEqual({
      line1: "Postfach 10 20 30",
      line2: "Gebäude B",
      line3: "Einkauf",
      city: "Köln",
      postalCode: "50667",
      countryCode: "DE",
    });
    const bare = en16931({
      ...s,
      buyer: { ...s.buyer, address: { street: "", postalCode: "", city: "", countryCode: "AT" } },
    });
    expect(bare.buyer.address).toEqual({ countryCode: "AT" });
  });

  test("INV-19 App. A.3 BT-49: contact address → invoice e-mail → Leitweg-ID for public buyers → none", () => {
    const s = makeSnapshot();
    const withEa = en16931({
      ...s,
      buyer: { ...s.buyer, electronicAddress: { scheme: "9930", value: "DE811907980" } },
    });
    expect(withEa.buyer.electronicAddress).toEqual({ scheme: "9930", value: "DE811907980" });
    expect(en16931(s).buyer.electronicAddress).toEqual({ scheme: "EM", value: BUYERS.b2b.invoiceEmail });
    const publicBuyer = {
      ...s,
      buyer: { ...BUYERS.public, invoiceEmail: undefined },
      references: { ...s.references, buyerReference: "04011000-12345-34" },
    };
    expect(en16931(publicBuyer).buyer.electronicAddress).toEqual({ scheme: "0204", value: "04011000-12345-34" });
    const noRef = { ...publicBuyer, references: { ...s.references, buyerReference: undefined } };
    expect(en16931(noRef).buyer.electronicAddress).toBeUndefined();
    const b2bNoMail = { ...s, buyer: { ...s.buyer, invoiceEmail: undefined } };
    expect(en16931(b2bNoMail).buyer).not.toHaveProperty("electronicAddress");
  });

  test("INV-19 BT-28/BT-45 trading names and the seller contact are written only when present", () => {
    const s = makeSnapshot();
    const inv = en16931({
      ...s,
      seller: {
        ...s.seller,
        tradeName: "Muster Design",
        contact: { name: "", phone: "", email: "" },
        electronicAddress: undefined,
      },
      buyer: { ...s.buyer, tradeName: "Beispiel" },
    });
    expect(inv.seller.tradeName).toBe("Muster Design");
    expect(inv.seller.contact).toEqual({});
    expect(inv.seller).not.toHaveProperty("electronicAddress");
    expect(inv.buyer.tradeName).toBe("Beispiel");
    const plain = en16931(s);
    expect(plain.seller).not.toHaveProperty("tradeName");
    expect(plain.buyer).not.toHaveProperty("tradeName");
    expect(plain.seller.contact).toEqual({
      name: SELLERS.gmbh.contact.name,
      phone: SELLERS.gmbh.contact.phone,
      email: SELLERS.gmbh.contact.email,
    });
  });

  test("INV-19 BR-CO-26 a seller without register, VAT ID and tax number has no BT-29/BT-32", () => {
    const s = makeSnapshot();
    const inv = en16931({ ...s, seller: { ...s.seller, register: undefined, vatId: undefined, taxNumber: undefined } });
    expect(inv.seller).not.toHaveProperty("identifier");
    expect(inv.seller).not.toHaveProperty("taxNumber");
    expect(inv.seller).not.toHaveProperty("registerNumber");
  });
});

describe("mapToEn16931 — notes and references (App. A.1, A.5, A.6)", () => {
  test("INV-19 BG-1 subject, head and foot texts become AAI/SUR notes in reading order", () => {
    const inv = en16931(
      makeSnapshot({ texts: { subject: "Projekt Relaunch", headText: "Vielen Dank.", footText: "Bis bald." } }),
    );
    const aai = inv.notes.filter((n) => n.subjectCode === "AAI").map((n) => n.text);
    expect(aai.slice(0, 2)).toEqual(["Projekt Relaunch", "Vielen Dank."]);
    expect(inv.notes.at(-1)).toEqual({ subjectCode: "SUR", text: "Bis bald." });
  });

  test("INV-13 a rectification without the rect_info note lists the corrected fields as a note", () => {
    const s = makeSnapshot();
    const inv = en16931({ ...s, rectifiedFields: ["Leistungsdatum", "Anschrift"] });
    expect(inv.notes).toContainEqual({ subjectCode: "AAI", text: "Berichtigt: Leistungsdatum, Anschrift" });
  });

  test("INV-19 BT-16: one delivery note is the despatch advice reference, several are listed in a note", () => {
    const one = en16931(makeSnapshot({ references: { deliveryNoteNumbers: ["LS-1"] } }));
    expect(one.despatchAdviceReference).toBe("LS-1");
    const several = en16931(makeSnapshot({ references: { deliveryNoteNumbers: ["LS-1", "LS-2"] }, language: "en" }));
    expect(several.despatchAdviceReference).toBeUndefined();
    expect(several.notes).toContainEqual({ subjectCode: "AAI", text: "Delivery notes: LS-1, LS-2" });
    const de = en16931(makeSnapshot({ references: { deliveryNoteNumbers: ["LS-1", "LS-2"] } }));
    expect(de.notes).toContainEqual({ subjectCode: "AAI", text: "Lieferscheine: LS-1, LS-2" });
  });

  test("INV-19 BT-11 the project reference is written when set", () => {
    expect(en16931(makeSnapshot({ references: { projectReference: "P-77" } })).projectReference).toBe("P-77");
    expect(en16931(makeSnapshot())).not.toHaveProperty("projectReference");
  });

  test("INV-09 App. A.6 deduction notes in English name the receipt date; German ones too", () => {
    const deduction = {
      advanceNumber: "RE-2025-0210",
      advanceDate: "2025-11-20",
      paidOn: "2025-11-28",
      byGroup: [{ category: "S" as const, rateBp: 1900, netCents: 10_000, vatCents: 1_900, grossCents: 11_900 }],
      deductedGrossCents: 11_900,
      partiallyPaid: false,
    };
    const input = {
      type: "final_invoice" as const,
      chain: { orderLabel: { de: "Auftrag", en: "order" }, orderNumber: "AB-1", orderDate: "2025-11-03" },
      lines: [item({ unitPriceMicros: 100_000_000 })],
      deductions: [deduction],
    };
    const en = en16931(makeSnapshot({ ...input, language: "en" }));
    const enNote = en.notes.find((n) => n.text.startsWith("Less advance invoice RE-2025-0210"));
    expect(enNote?.text).toMatch(/\(received .+\)$/);
    expect(enNote?.text).toContain("VAT 19");
    const de = en16931(makeSnapshot(input));
    const deNote = de.notes.find((n) => n.text.startsWith("Abzüglich Abschlagsrechnung RE-2025-0210"));
    expect(deNote?.text).toContain("(erhalten am 28.11.2025)");
  });

  test("INV-19 BG-13 a delivery date alone creates the delivery block; a period does not", () => {
    const withDate = en16931(makeSnapshot());
    expect(withDate.delivery).toEqual({ date: "2026-10-09" });
    const period = en16931(makeSnapshot({ supplyDate: { kind: "period", from: "2026-09-01", to: "2026-09-30" } }));
    expect(period).not.toHaveProperty("delivery");
    expect(period.invoicePeriod).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });
});

describe("mapToEn16931 — lines and allowances (App. A.10, App. E.3)", () => {
  test("INV-19 BR-27 a negative unit price moves its sign to the quantity (BT-146 stays ≥ 0)", () => {
    const inv = en16931(
      makeSnapshot({
        lines: [item({ quantityMilli: 2_000, unitPriceMicros: 1_000_000 }), item({ unitPriceMicros: -500_000 })],
      }),
    );
    expect(inv.lines[1]).toMatchObject({ quantityMilli: -1_000, priceMicros: 500_000, netCents: -5_000 });
  });

  test("DOC-07 an amount line discount is a BG-27 allowance without percentage; English reason „Discount“", () => {
    const inv = en16931(
      makeSnapshot({
        language: "en",
        lines: [item({ unitPriceMicros: 10_000_000, discount: { kind: "amount", cents: 1_500 } })],
      }),
    );
    expect(inv.lines[0]?.allowance).toEqual({
      amountCents: 1_500,
      baseCents: 100_000,
      reason: "Discount",
      reasonCode: "95",
    });
  });

  test("DOC-10 gross mode: a unit price not representable at 4 decimals moves to BT-149 base quantity", () => {
    // 1 000 × 0,0123 € gross at 19 % → line net 10,34 €; 10,34 / 1 000 is not exact at 4 decimals → BT-149 = 1 000.
    const inv = en16931(
      makeSnapshot({
        priceMode: "gross",
        buyer: BUYERS.consumer,
        lines: [item({ quantityMilli: 1_000_000, unitPriceMicros: 123 })],
      }),
    );
    const l = inv.lines[0];
    expect(l?.netCents).toBe(1_034);
    expect(l?.baseQuantityMilli).toBe(1_000_000);
    expect(l?.quantityMilli).toBe(1_000_000);
    expect(l?.priceMicros).toBe((l?.netCents ?? 0) * 100);
  });

  test("INV-19 BT-156 the buyer's item number is written when set", () => {
    const inv = en16931(makeSnapshot({ lines: [item({ buyerItemNumber: "KD-ART-9", itemNumber: "ART-1" })] }));
    expect(inv.lines[0]).toMatchObject({ buyerItemId: "KD-ART-9", sellerItemId: "ART-1" });
  });

  test("DOC-07 a percentage document surcharge is a BG-21 charge per group with base and percentage", () => {
    const inv = en16931(
      makeSnapshot({
        lines: [item({ unitPriceMicros: 10_000_000 })],
        adjustment: { type: "charge", percentBp: 500, reason: "Expresszuschlag" },
      }),
    );
    expect(inv.allowanceCharges).toEqual([
      {
        charge: true,
        amountCents: 5_000,
        percentBp: 500,
        baseCents: 100_000,
        category: "S",
        rateBp: 1900,
        reason: "Expresszuschlag",
        reasonCode: "ZZZ",
      },
    ]);
    expect(inv.totals.chargeCents).toBe(5_000);
  });
});
