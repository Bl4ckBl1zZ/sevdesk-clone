import { describe, expect, test } from "vitest";
import { BUYERS, makeSnapshot, SELLERS } from "../../../test/factories/snapshot";
import { checkKleinunternehmerDocument } from "./ku-invariants";

const kuLine = {
  kind: "item",
  name: "Fotoshooting",
  quantityMilli: 1000,
  unitCode: "C62",
  unitPriceMicros: 5_000_000,
  vatCategory: "KU",
  vatRateBp: 0,
} as const;

const kuSnapshot = () =>
  makeSnapshot({ seller: SELLERS.ku, buyer: BUYERS.consumer, taxCase: "kleinunternehmer", lines: [kuLine] });

const KU_2026 = [{ validFrom: "2026-01-01", isKU: true }];
const REGULAR_2026 = [{ validFrom: "2026-01-01", isKU: false }];

describe("RI-17 Kleinunternehmer documents", () => {
  test("RI-17 a KU invoice without VAT and a regular invoice with VAT pass", () => {
    expect(checkKleinunternehmerDocument({ name: "RE-1", type: "invoice", snapshot: kuSnapshot() }, KU_2026)).toEqual(
      [],
    );
    expect(
      checkKleinunternehmerDocument({ name: "RE-2", type: "invoice", snapshot: makeSnapshot() }, REGULAR_2026),
    ).toEqual([]);
  });

  test("RI-17 a document finalised while KU applied must not show VAT", () => {
    const regular = makeSnapshot();
    const snapshot = { ...regular, seller: { ...regular.seller, kleinunternehmer: true } };
    const f = checkKleinunternehmerDocument({ name: "RE-3", type: "invoice", snapshot }, []);
    expect(f.map((x) => [x.id, x.severity])).toEqual([
      ["RI-17", "ERROR"],
      ["RI-17", "ERROR"],
    ]);
    expect(f[0]?.message).toContain("weist aber Umsatzsteuer aus");
  });

  test("RI-17 a document finalised after the KU limit was crossed must show VAT (no KU document)", () => {
    const ku = kuSnapshot();
    const snapshot = { ...ku, seller: { ...ku.seller, kleinunternehmer: false } };
    expect(checkKleinunternehmerDocument({ name: "RE-4", type: "invoice", snapshot }, [])).toEqual([
      expect.objectContaining({
        id: "RI-17",
        severity: "ERROR",
        message: expect.stringContaining("ohne Kleinunternehmerstatus"),
      }),
    ]);
  });

  test("RI-17 a retroactive KU history entry (EC-061) that contradicts the snapshot is a WARN", () => {
    const history = [...KU_2026, { validFrom: "2026-10-01", isKU: false }];
    expect(checkKleinunternehmerDocument({ name: "RE-5", type: "invoice", snapshot: kuSnapshot() }, history)).toEqual([
      expect.objectContaining({
        id: "RI-17",
        severity: "WARN",
        message: expect.stringContaining("Rechnungsberichtigung"),
      }),
    ]);
  });

  test("RI-17 Storno, imported documents and non-invoice types are not compared with today's history", () => {
    const history = [{ validFrom: "2026-01-01", isKU: false }];
    const snapshot = kuSnapshot();
    expect(checkKleinunternehmerDocument({ name: "ST-1", type: "cancellation", snapshot }, history)).toEqual([]);
    expect(checkKleinunternehmerDocument({ name: "RE-6", type: "invoice", snapshot, imported: true }, history)).toEqual(
      [],
    );
    expect(checkKleinunternehmerDocument({ name: "AN-1", type: "quote", snapshot }, history)).toEqual([]);
  });
});
