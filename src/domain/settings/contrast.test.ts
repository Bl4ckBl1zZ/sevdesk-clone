import { describe, expect, test } from "vitest";
import { ACCENT_MIN_CONTRAST, accentContrastWarning, contrastRatio } from "./contrast";

describe("SET-077 accent colour contrast against white", () => {
  test("SET-077 computes the WCAG 2.x contrast ratio against white", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // #767676 is the classic 4.54:1 grey
    expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
  });

  test("SET-077 warns (never blocks) below 3:1 and stays silent at or above it", () => {
    expect(ACCENT_MIN_CONTRAST).toBe(3);
    // the default accent #1F6FEB is well above 3:1
    expect(accentContrastWarning("#1F6FEB")).toBeNull();
    // #949494 ≈ 3.03:1 — just enough
    expect(accentContrastWarning("#949494")).toBeNull();
    // light yellow is unreadable on white
    const w = accentContrastWarning("#FFE066");
    expect(w).toEqual({
      code: "accent_contrast_low",
      message: expect.stringContaining("Kontrast"),
      params: { ratio: "1,3" },
    });
    expect(w?.message).toBe(
      "Die Akzentfarbe hat auf Weiß nur einen Kontrast von 1,3:1 (empfohlen mindestens 3:1) – Überschriften und Linien sind schlecht lesbar.",
    );
  });

  test("SET-077 ignores values that are not #RRGGBB (the schema reports those)", () => {
    expect(accentContrastWarning("rot")).toBeNull();
  });
});
