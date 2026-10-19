import { describe, expect, test } from "vitest";
import { bankdaten } from "./bankdaten";

const base = {
  today: "2026-10-19",
  provider: "Enable Banking Oy (Kontoinformationsdienst, eingeschränkter Modus mit eigenen verknüpften Konten)",
  applicationId: "1f3c0000-aaaa-bbbb-cccc-000000000001",
  status: "Verbunden",
  consentPeriods: [{ from: "2026-10-19", until: "2027-04-17" }],
  confirmation: { label: "ausstehend", recordedAt: null, note: null, fileName: null },
  feedLost: null,
  accounts: [
    {
      name: "Revolut EUR",
      currency: "EUR",
      iban: "LT12…",
      source: "Enable Banking + Kontoauszug-Import",
      archived: false,
    },
  ],
};

describe("Verfahrensdokumentation „Bankdaten“ (BNK-116)", () => {
  test("BNK-116 the chapter prints provider, application ID, consent periods and the confirmation status", () => {
    const doc = bankdaten(base);
    expect(doc.title).toBe("Bankdaten");
    expect(doc.stand).toBe("19.10.2026");
    const provider = doc.sections.find((s) => s.heading === "Anbieter und Zustimmung");
    expect(provider?.paragraphs.join(" ")).toContain("Anwendungs-ID: 1f3c0000-aaaa-bbbb-cccc-000000000001");
    expect(provider?.paragraphs.join(" ")).toContain(
      "Schriftliche Bestätigung von Enable Banking zur Nutzung im eingeschränkten Modus: ausstehend.",
    );
    expect(provider?.table?.rows).toEqual([["19.10.2026", "17.04.2027"]]);
    expect(doc.sections[0]?.table?.rows[0]).toEqual([
      "Revolut EUR",
      "EUR",
      "LT12…",
      "Enable Banking + Kontoauszug-Import",
    ]);
  });

  test("BNK-116 BNK-117 without a feed only the statement import is documented; a lost feed is recorded", () => {
    const none = bankdaten({
      ...base,
      provider: null,
      applicationId: null,
      status: null,
      consentPeriods: [],
      confirmation: null,
    });
    expect(none.sections.map((s) => s.heading)).toEqual(["Datenquellen", "Aufbewahrung"]);
    const lost = bankdaten({
      ...base,
      confirmation: {
        label: "bestätigt",
        recordedAt: "2026-10-20",
        note: "E-Mail vom Support",
        fileName: "bestaetigung.pdf",
      },
      feedLost: { at: "2027-01-05", reason: "Eingeschränkter Modus beendet" },
    });
    const text = lost.sections.flatMap((s) => s.paragraphs).join(" ");
    expect(text).toContain("bestätigt (erfasst am 20.10.2026) – E-Mail vom Support; Nachweis: bestaetigung.pdf.");
    expect(text).toContain("Zugang zur Bankanbindung beendet am 05.01.2027: Eingeschränkter Modus beendet.");
  });
});
