import { describe, expect, test } from "vitest";
import { isLateMark, LATE_MARK_WARNING_DE, lateMarkWarning } from "./late-mark";

describe("DUN-056 EC-DUN-33 late sent mark", () => {
  test("DUN-056 EC-DUN-33 T05-170 more than 3 calendar days after the document date warns", () => {
    expect(isLateMark("2026-07-01", "2026-07-04")).toBe(false);
    expect(isLateMark("2026-07-01", "2026-07-06")).toBe(true);
    expect(isLateMark("2026-10-10", "2026-10-14")).toBe(true);
    expect(isLateMark(null, "2026-10-14")).toBe(false);
    expect(isLateMark("2026-10-10", "kaputt")).toBe(false);
    expect(lateMarkWarning("reminder", "2026-07-01", "2026-07-06")).toBe(LATE_MARK_WARNING_DE);
    expect(LATE_MARK_WARNING_DE).toBe("Die im Schreiben genannte Frist ist ggf. zu kurz – Mahnung neu erstellen?");
    expect(lateMarkWarning("invoice", "2026-07-01", "2026-07-06")).toBeNull();
    expect(lateMarkWarning("reminder", "2026-07-01", "2026-07-02")).toBeNull();
  });
});
