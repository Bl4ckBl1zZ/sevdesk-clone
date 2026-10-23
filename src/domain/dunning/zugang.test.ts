import { describe, expect, test } from "vitest";
import { zugangFor } from "../documents/dispatch";
import { validateZugangOverride, zugangNotice } from "./zugang";

describe("Zugang notices and override (PAY-052, PAY-064, MAHN-01)", () => {
  test("EC-DUE-07 EC-196 an invoice without a sent mark has no Zugang: warning that default and dunning do not start", () => {
    expect(zugangNotice({ zugang: undefined })).toEqual({
      code: "invoice_not_marked_sent",
      severity: "W",
      message:
        "Die Rechnung ist nicht als versendet markiert – ohne Zugang beginnt kein Verzug und es wird nicht gemahnt.",
    });
    expect(zugangNotice({ zugang: { date: "2026-10-12", basis: "email_manual" } })).toBeNull();
  });

  test("EC-DUE-08 SND-23 channel „Sonstiges“ → Zugang = sentOn + 3 days (conservative) with an info", () => {
    const z = zugangFor({ sentOn: "2026-10-12", channel: "other" }, 3);
    expect(z).toEqual({ date: "2026-10-15", basis: "other" });
    expect(zugangNotice({ zugang: z })).toEqual({
      code: "zugang_other_channel",
      severity: "I",
      message: "Zugang angenommen am 15.10.2026 (Versandweg ‚Sonstiges‘: + 3 Tage).",
    });
    // the postal days setting does not change the „other“ rule; e-mail is the same day
    expect(zugangFor({ sentOn: "2026-10-12", channel: "other" }, 5).date).toBe("2026-10-15");
    expect(zugangFor({ sentOn: "2026-10-12", channel: "email_manual" }, 3).date).toBe("2026-10-12");
  });

  test("EC-DUE-09 a manual Zugang before sentOn, in the future or without a reason is rejected", () => {
    const msg = "Das Zugangsdatum muss zwischen Versanddatum (12.10.2026) und heute liegen und begründet werden.";
    const base = { sentOn: "2026-10-12", today: "2026-10-20", reason: "Rückschein vom 14.10." };
    expect(validateZugangOverride({ ...base, date: "2026-10-14" })).toBeNull();
    expect(validateZugangOverride({ ...base, date: "2026-10-12" })).toBeNull();
    expect(validateZugangOverride({ ...base, date: "2026-10-20" })).toBeNull();
    expect(validateZugangOverride({ ...base, date: "2026-10-11" })).toBe(msg);
    expect(validateZugangOverride({ ...base, date: "2026-10-21" })).toBe(msg);
    expect(validateZugangOverride({ ...base, date: "2026-10-14", reason: " ok " })).toBe(msg);
    expect(validateZugangOverride({ ...base, sentOn: undefined, date: "2026-10-14" })).toBe(
      "Das Zugangsdatum muss zwischen Versanddatum (–) und heute liegen und begründet werden.",
    );
  });
});
