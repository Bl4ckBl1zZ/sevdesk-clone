import { describe, expect, test } from "vitest";
import { UNIT_CODES } from "../rules/unit-codes";
import { checkDeleteUnit, SEED_UNITS, validateUnit } from "./units";

describe("SET-090 units", () => {
  test("SET-090 the seed list of §5.7 uses valid Rec 20/21 codes, C62 and HUR first-class", () => {
    expect(SEED_UNITS).toHaveLength(35);
    for (const u of SEED_UNITS) expect(UNIT_CODES.has(u.code), u.code).toBe(true);
    expect(SEED_UNITS.find((u) => u.code === "HUR")?.label).toEqual({ de: "Std.", en: "h" });
    expect(SEED_UNITS.find((u) => u.code === "C62")?.label).toEqual({ de: "Stk.", en: "pc" });
    expect(new Set(SEED_UNITS.map((u) => u.code)).size).toBe(35);
  });

  test("SET-090 UST-07 custom units only with a code from the bundled list; labels 1–20 characters", () => {
    expect(validateUnit({ code: "XPP", label: { de: "Palettenplatz", en: "pallet place" } }, [])).toEqual({
      ok: true,
      value: undefined,
    });
    expect(validateUnit({ code: "XYZ1", label: { de: "x", en: "x" } }, [])).toMatchObject({
      ok: false,
      error: { code: "UNIT_CODE_INVALID", message: "„XYZ1“ ist kein gültiger Einheitencode nach UN/ECE Rec 20/21." },
    });
    expect(validateUnit({ code: "hur", label: { de: "x", en: "x" } }, [])).toMatchObject({
      error: { code: "UNIT_CODE_INVALID" },
    });
    expect(validateUnit({ code: "HUR", label: { de: "Std.", en: "h" } }, ["HUR"])).toMatchObject({
      error: { code: "UNIT_DUPLICATE" },
    });
    expect(validateUnit({ code: "KGM", label: { de: "", en: "kg" } }, [])).toMatchObject({
      error: { code: "UNIT_LABEL_INVALID" },
    });
    expect(validateUnit({ code: "KGM", label: { de: "k".repeat(21), en: "kg" } }, [])).toMatchObject({
      error: { code: "UNIT_LABEL_INVALID" },
    });
  });
});

describe("SET-091 units in use are archived, not deleted", () => {
  test("SET-091 a used unit gives UNIT_IN_USE; system units are never deleted; unused custom units can be deleted", () => {
    expect(checkDeleteUnit({ isSystem: false }, 3)).toMatchObject({
      code: "UNIT_IN_USE",
      message: "Die Einheit wird verwendet und kann nur archiviert werden.",
    });
    expect(checkDeleteUnit({ isSystem: true }, 0)).toMatchObject({ code: "UNIT_SYSTEM" });
    expect(checkDeleteUnit({ isSystem: false }, 0)).toBeNull();
  });
});
