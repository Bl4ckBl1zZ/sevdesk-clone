import { describe, expect, test } from "vitest";
import { resumeStep, WIZARD_STEPS } from "./steps";

describe("setup wizard steps (F01 §3.1)", () => {
  test("SET-002 the wizard has the eleven steps in F01 order; only Bank and Layout can be skipped", () => {
    expect(WIZARD_STEPS.map((s) => s.key)).toEqual([
      "inhaberkonto",
      "zugriff",
      "email",
      "speicher",
      "start",
      "unternehmen",
      "steuern",
      "bank",
      "layout",
      "nummernkreise",
      "fertig",
    ]);
    expect(WIZARD_STEPS.filter((s) => s.skippable).map((s) => s.key)).toEqual(["bank", "layout"]);
    expect(WIZARD_STEPS.map((s) => s.slug).join(" ")).not.toMatch(/smtp|imap|zahlung/i);
  });

  test("SET-003 the wizard resumes at the first incomplete step", () => {
    expect(resumeStep([]).key).toBe("inhaberkonto");
    expect(resumeStep(["inhaberkonto", "zugriff"]).key).toBe("email");
    expect(resumeStep(WIZARD_STEPS.map((s) => s.key)).key).toBe("fertig");
  });
});
