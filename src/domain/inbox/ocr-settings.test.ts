import { describe, expect, test } from "vitest";
import { OCR_MESSAGES } from "./ocr";
import { budgetExceeded, CLAUDE_DEFAULTS, checkClaudeSettings, nextUsage } from "./ocr-settings";
import { sanitizeUntrusted, untrustedText } from "./untrusted";

describe("Claude OCR settings (SET-111, EC-INB-16/17)", () => {
  test("SET-111 defaults: model claude-sonnet-5-5, first 5 pages; enabling requires the AVV confirmation", () => {
    expect(CLAUDE_DEFAULTS).toMatchObject({ model: "claude-sonnet-5-5", pageLimit: 5 });
    const noDpa = checkClaudeSettings({ enabled: true, dpaConfirmed: false, region: "eu" });
    expect(noDpa.errors.map((e) => e.code)).toEqual(["dpa_required"]);
    expect(noDpa.errors[0]?.message).toContain("Auftragsverarbeitungsvertrag (AVV)");
    expect(checkClaudeSettings({ enabled: false, dpaConfirmed: false, region: "eu" }).errors).toEqual([]);
    expect(checkClaudeSettings({ enabled: true, dpaConfirmed: true, region: "eu" })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  test("SET-111 EC-INB-17 T06-034 a non-EU region shows NON_EU_ENDPOINT", () => {
    const us = checkClaudeSettings({ enabled: true, dpaConfirmed: true, region: "us" });
    expect(us.warnings.map((w) => w.code)).toEqual(["NON_EU_ENDPOINT"]);
    expect(us.warnings[0]?.message).toContain("außerhalb der EU (USA)");
    expect(us.warnings[0]?.message).toContain(OCR_MESSAGES.nonEu);
    expect(checkClaudeSettings({ enabled: true, dpaConfirmed: true, region: "global" }).warnings).toHaveLength(1);
  });

  test("SET-111 endpoint must be https; page limit and budget are positive integers", () => {
    const r = checkClaudeSettings({
      enabled: true,
      dpaConfirmed: true,
      region: "eu",
      endpoint: "http://claude.example.eu",
      pageLimit: 0,
      monthlyBudget: -3,
      model: " ",
    });
    expect(r.errors.map((e) => e.code).sort()).toEqual([
      "budget_invalid",
      "endpoint_invalid",
      "model_required",
      "page_limit_invalid",
    ]);
  });

  test("INB-025 the monthly call budget resets with the month", () => {
    expect(budgetExceeded(undefined, undefined, "2026-10-19")).toBe(false);
    expect(budgetExceeded({ month: "2026-10", calls: 99 }, 100, "2026-10-19")).toBe(false);
    expect(budgetExceeded({ month: "2026-10", calls: 100 }, 100, "2026-10-19")).toBe(true);
    expect(budgetExceeded({ month: "2026-09", calls: 500 }, 100, "2026-10-01")).toBe(false);
    expect(nextUsage({ month: "2026-09", calls: 5 }, "2026-10-01")).toEqual({ month: "2026-10", calls: 1 });
    expect(nextUsage({ month: "2026-10", calls: 5 }, "2026-10-02")).toEqual({ month: "2026-10", calls: 6 });
  });

  test("EC-INB-16 the disabled message is the spec text", () => {
    expect(OCR_MESSAGES.disabled).toBe("Automatische Belegerkennung ist deaktiviert.");
  });
});

describe("untrusted text (INB-030, 06 §2.7)", () => {
  test("INB-030 EC-INB-19 document text is delimited as untrusted_text, control and bidi characters removed", () => {
    expect(untrustedText("  Rechnung\u0000 Nr. 1‮  ")).toEqual({ untrusted_text: "Rechnung Nr. 1" });
    expect(untrustedText("")).toBeNull();
    expect(untrustedText(null)).toBeNull();
    expect(untrustedText("x".repeat(10), 5)).toEqual({ untrusted_text: "xxxx…" });
    expect(sanitizeUntrusted("a\r\nb")).toBe("a\nb");
  });
});
