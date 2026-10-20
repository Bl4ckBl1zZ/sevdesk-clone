import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { finalizedInvoice } from "./invoices.fixtures";
import { makeT } from "./test.setup";

/** F09 EXP-020 Kennzahlen sheets (UStVA/ZM) as PDF/A and CSV with the footer (rule versions, lock, filing). */

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Kennzahlen sheets (EXP-020)", { timeout: 180_000 }, () => {
  test("EXP-020 TST-EXP-24 UStVA 10/2026 as CSV equals the F08 sheet values; PDF/A renders; footer with lock and filing status", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const view = await f.owner.query(api.taxes.ustva, { period: "2026-10" });
    expect(view.sheet).not.toBeNull();
    const csv = await f.owner.action(api.kennzahlenNode.download, { form: "ustva", period: "2026-10", format: "csv" });
    expect(csv).toMatchObject({ name: "UStVA_2026-10_Kennzahlen.csv", mime: "text/csv;charset=utf-8" });
    const text = new TextDecoder().decode(csv.data);
    for (const field of view.sheet?.fields ?? []) {
      const cents = Math.abs(field.valueCents);
      const value = `${field.valueCents < 0 ? "-" : ""}${Math.trunc(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
      expect(text).toContain(`\r\n${field.kz};`);
      expect(
        text
          .split("\r\n")
          .find((l) => l.startsWith(`${field.kz};`))
          ?.split(";")[2],
      ).toBe(value);
    }
    expect(text).toContain(`Regelversionen;${view.sheet?.mappingVersion}`);
    expect(text).toContain("Festschreibung;nicht festgeschrieben");
    expect(text).toContain("Abgabestatus;nicht übermittelt");

    const pdf = await f.owner.action(api.kennzahlenNode.download, { form: "ustva", period: "2026-10", format: "pdf" });
    expect(pdf.name).toBe("UStVA_2026-10_Kennzahlen.pdf");
    expect(new TextDecoder().decode(new Uint8Array(pdf.data).subarray(0, 5))).toBe("%PDF-");

    const zm = await f.owner.action(api.kennzahlenNode.download, { form: "zm", period: "2026-Q4", format: "csv" });
    expect(new TextDecoder().decode(zm.data)).toContain(
      "Land;USt-IdNr.;Name;Art;Betrag (Euro, Formular);laut Buchhaltung",
    );
  });

  test("EXP-020 AUD-023 the auditor gets the sheets of the granted years only", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    const a2025 = await t.asUser("auditor", { auditor: { purpose: "Betriebsprüfung 2025", fiscalYears: [2025] } });
    expect(
      dataOf(
        await catching(a2025.action(api.kennzahlenNode.download, { form: "ustva", period: "2026-10", format: "csv" })),
      ).code,
    ).toBe("not_found");
    const viewer = await t.asUser("viewer");
    await expect(
      viewer.action(api.kennzahlenNode.download, { form: "ustva", period: "2026-10", format: "csv" }),
    ).resolves.toMatchObject({ name: "UStVA_2026-10_Kennzahlen.csv" });
  });
});
