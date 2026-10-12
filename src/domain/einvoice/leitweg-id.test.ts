import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { validateBuyerReference } from "./buyer-reference";
import { leitwegCheckDigits, validateLeitwegId } from "./leitweg-id";

const code = (r: { ok: true } | { ok: false; error: { code: string } }) => (r.ok ? null : r.error.code);

describe("Leitweg-ID (ER-20, F02 §5.5)", () => {
  test("ER-20 accepts valid Leitweg-IDs (ISO 7064 Mod 97-10)", () => {
    for (const id of ["04011000-1234512345-06", "991-01234-38", "991-33333TEST-33"]) {
      const r = validateLeitwegId(id);
      expect(r.ok && r.value, id).toBe(id);
    }
  });

  test("EC-DOC-76 missing → leitweg_id_missing, bad format → leitweg_id_invalid, wrong check digits → leitweg_id_checksum", () => {
    expect(code(validateLeitwegId(undefined))).toBe("leitweg_id_missing");
    expect(code(validateLeitwegId("  "))).toBe("leitweg_id_missing");
    expect(code(validateLeitwegId("99-AB"))).toBe("leitweg_id_invalid");
    expect(code(validateLeitwegId("1-01234-38"))).toBe("leitweg_id_invalid"); // Grob < 2 digits
    expect(code(validateLeitwegId("1234567890123-38"))).toBe("leitweg_id_invalid"); // Grob > 12 digits
    expect(code(validateLeitwegId(`991-${"A".repeat(31)}-38`))).toBe("leitweg_id_invalid");
    expect(code(validateLeitwegId("991-01234-3"))).toBe("leitweg_id_invalid");
    expect(code(validateLeitwegId("991_01234-38"))).toBe("leitweg_id_invalid");
    const bad = validateLeitwegId("991-01234-44");
    expect(code(bad)).toBe("leitweg_id_checksum");
    expect(bad.ok ? "" : bad.error.message).toBe("Die Prüfziffer der Leitweg-ID stimmt nicht.");
  });

  test("CON-084 lower-case letters in the Feinadressierung are normalised to upper case; whitespace is trimmed", () => {
    const r = validateLeitwegId(" 991-33333test-33 ");
    expect(r.ok && r.value).toBe("991-33333TEST-33");
  });

  test("ER-20 check digits for a new ID are 98 − (number·100 mod 97); generated IDs always validate", () => {
    expect(leitwegCheckDigits("991-01234")).toBe("38");
    expect(leitwegCheckDigits("04011000-1234512345")).toBe("06");
    expect(leitwegCheckDigits("991-33333TEST")).toBe("33");
    expect(() => leitwegCheckDigits("x")).toThrow(/leitweg_id_invalid/);
    fc.assert(
      fc.property(
        fc.stringMatching(/^\d{2,12}$/),
        fc.option(fc.stringMatching(/^[A-Z0-9]{1,30}$/), { nil: undefined }),
        (grob, fein) => {
          const base = fein === undefined ? grob : `${grob}-${fein}`;
          const id = `${base}-${leitwegCheckDigits(base)}`;
          expect(validateLeitwegId(id).ok).toBe(true);
          // every single-digit change in the check digits is detected
          const last = id.slice(-1);
          const changed = `${id.slice(0, -1)}${last === "9" ? "0" : String(Number(last) + 1)}`;
          expect(code(validateLeitwegId(changed))).toBe("leitweg_id_checksum");
        },
      ),
    );
  });

  test("CON-084 buyer reference: Leitweg-ID for public authorities, otherwise free text ≤ 100 characters", () => {
    expect(code(validateBuyerReference({ value: "991-01234-38", isPublicAuthority: true }))).toBeNull();
    expect(code(validateBuyerReference({ value: "", isPublicAuthority: true }))).toBe("leitweg_id_missing");
    expect(code(validateBuyerReference({ value: "991-01234-44", isPublicAuthority: true }))).toBe(
      "leitweg_id_checksum",
    );
    expect(code(validateBuyerReference({ value: "PO 4711", isPublicAuthority: false }))).toBeNull();
    expect(code(validateBuyerReference({ value: undefined, isPublicAuthority: false }))).toBeNull();
    const long = validateBuyerReference({ value: "x".repeat(101), isPublicAuthority: false });
    expect(code(long)).toBe("too_long");
    expect(long.ok ? "" : long.error.message).toBe("Die Käuferreferenz ist zu lang (max. 100 Zeichen).");
    const ok = validateBuyerReference({ value: "  PO 4711 ", isPublicAuthority: false });
    expect(ok.ok && ok.value).toBe("PO 4711");
    const none = validateBuyerReference({ value: "   ", isPublicAuthority: false });
    expect(none.ok && none.value).toBeNull();
  });
});
