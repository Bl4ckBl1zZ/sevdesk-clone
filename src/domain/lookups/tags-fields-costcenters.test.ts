import { describe, expect, test } from "vitest";
import { validateCostCenter } from "./cost-centers";
import {
  CUSTOM_FIELD_LIMIT,
  checkCustomFieldChange,
  validateCustomFieldDef,
  validateCustomFieldValue,
} from "./custom-fields";
import { TAG_COLORS, validateTag } from "./tags";

describe("SET-094 tags", () => {
  test("SET-094 names 1–40 characters, unique case-insensitive, colour from the theme palette", () => {
    expect(validateTag({ name: "Wichtig", color: "red" }, [])).toEqual({ ok: true, value: undefined });
    expect(validateTag({ name: "wichtig" }, [{ id: "a", name: "Wichtig" }])).toMatchObject({
      error: { code: "TAG_DUPLICATE", message: "Ein Tag mit diesem Namen existiert bereits." },
    });
    // Renaming a tag to its own name (other casing) is fine.
    expect(validateTag({ id: "a", name: "WICHTIG" }, [{ id: "a", name: "Wichtig" }]).ok).toBe(true);
    expect(validateTag({ name: "" }, [])).toMatchObject({ error: { code: "TAG_INVALID" } });
    expect(validateTag({ name: "x".repeat(41) }, [])).toMatchObject({ error: { code: "TAG_INVALID" } });
    expect(validateTag({ name: "a", color: "#ff0000" }, [])).toMatchObject({ error: { code: "TAG_INVALID" } });
    expect(TAG_COLORS).toContain("blue");
  });
});

describe("SET-095 custom field definitions", () => {
  const defs = [{ entity: "contact" as const, key: "projekt" }];

  test("SET-095 key pattern, duplicates per entity, select options 1–50, at most 30 per entity", () => {
    expect(
      validateCustomFieldDef({ entity: "contact", key: "kostenstelle", label: "Kostenstelle", type: "text" }, defs).ok,
    ).toBe(true);
    expect(validateCustomFieldDef({ entity: "product", key: "projekt", label: "Projekt", type: "text" }, defs).ok).toBe(
      true,
    );
    expect(validateCustomFieldDef({ entity: "contact", key: "Projekt", label: "P", type: "text" }, defs)).toMatchObject(
      {
        error: {
          code: "CUSTOM_FIELD_KEY_INVALID",
          message: "Schlüssel: Kleinbuchstaben, Ziffern und _, beginnend mit einem Buchstaben.",
        },
      },
    );
    expect(validateCustomFieldDef({ entity: "contact", key: "projekt", label: "P", type: "text" }, defs)).toMatchObject(
      {
        error: { code: "CUSTOM_FIELD_DUPLICATE" },
      },
    );
    expect(
      validateCustomFieldDef({ entity: "contact", key: "art", label: "Art", type: "select", options: [] }, defs),
    ).toMatchObject({
      error: { code: "CUSTOM_FIELD_OPTIONS", message: "Auswahlfelder brauchen 1 bis 50 Optionen." },
    });
    const many = Array.from({ length: 51 }, (_, i) => `o${i}`);
    expect(
      validateCustomFieldDef({ entity: "contact", key: "art", label: "Art", type: "select", options: many }, defs),
    ).toMatchObject({
      error: { code: "CUSTOM_FIELD_OPTIONS" },
    });
    const thirty = Array.from({ length: CUSTOM_FIELD_LIMIT }, (_, i) => ({
      entity: "document" as const,
      key: `f${i}`,
    }));
    expect(
      validateCustomFieldDef({ entity: "document", key: "neu", label: "Neu", type: "text" }, thirty),
    ).toMatchObject({
      error: { code: "CUSTOM_FIELD_LIMIT", message: "Höchstens 30 eigene Felder pro Bereich." },
    });
  });

  test("SET-095 GOBD-03 values are validated by type", () => {
    const def = (type: string, options?: string[]) =>
      ({ label: "Feld", type, ...(options ? { options } : {}) }) as never;
    expect(validateCustomFieldValue(def("number"), 12.5).ok).toBe(true);
    expect(validateCustomFieldValue(def("number"), "12")).toMatchObject({
      error: { code: "CUSTOM_FIELD_VALUE_INVALID", message: "„Feld“: ungültiger Wert." },
    });
    expect(validateCustomFieldValue(def("date"), "2026-02-30").ok).toBe(false);
    expect(validateCustomFieldValue(def("date"), "2026-10-12").ok).toBe(true);
    expect(validateCustomFieldValue(def("select", ["A", "B"]), "C").ok).toBe(false);
    expect(validateCustomFieldValue(def("select", ["A", "B"]), "B").ok).toBe(true);
    expect(validateCustomFieldValue(def("boolean"), "true").ok).toBe(false);
    expect(validateCustomFieldValue(def("text"), "x".repeat(1001)).ok).toBe(false);
    expect(validateCustomFieldValue({ label: "Pflicht", type: "text", required: true } as never, "").ok).toBe(false);
    expect(validateCustomFieldValue(def("text"), undefined).ok).toBe(true);
  });
});

describe("SET-096 changing definitions", () => {
  test("SET-096 the type is locked once values exist; the key never changes", () => {
    const before = { key: "projekt", type: "text" as const };
    expect(checkCustomFieldChange(before, { key: "projekt", type: "number" }, 0)).toBeNull();
    expect(checkCustomFieldChange(before, { key: "projekt", type: "number" }, 2)).toMatchObject({
      code: "CUSTOM_FIELD_TYPE_LOCKED",
      message: "Der Typ kann nicht geändert werden, weil bereits Werte gespeichert sind.",
    });
    expect(checkCustomFieldChange(before, { key: "projekt2", type: "text" }, 0)).toMatchObject({
      code: "CUSTOM_FIELD_KEY_LOCKED",
    });
  });
});

describe("SET-097 cost centres", () => {
  test("SET-097 DATEV-02 numbers 1–36 letters/digits, unique; warning above 8 characters", () => {
    expect(validateCostCenter({ number: "100", name: "Vertrieb" }, [])).toEqual({ ok: true, value: { warnings: [] } });
    expect(validateCostCenter({ number: "KST-1", name: "x" }, [])).toMatchObject({
      error: { code: "COST_CENTER_INVALID", message: "Kostenstellennummer: 1–36 Buchstaben/Ziffern, eindeutig." },
    });
    expect(validateCostCenter({ number: "100", name: "x" }, [{ id: "a", number: "100" }])).toMatchObject({
      error: { code: "COST_CENTER_INVALID" },
    });
    expect(validateCostCenter({ id: "a", number: "100", name: "x" }, [{ id: "a", number: "100" }]).ok).toBe(true);
    expect(validateCostCenter({ number: "PROJEKT2026", name: "Projekt" }, [])).toEqual({
      ok: true,
      value: { warnings: ["Ältere DATEV-Versionen akzeptieren nur 8 Zeichen."] },
    });
    expect(validateCostCenter({ number: "100", name: "" }, [])).toMatchObject({ error: { code: "COST_CENTER_NAME" } });
  });
});
