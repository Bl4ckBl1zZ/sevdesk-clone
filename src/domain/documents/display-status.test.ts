import { describe, expect, test } from "vitest";
import { type DisplayStatusInput, displayStatus } from "./display-status";

const base: DisplayStatusInput = {
  type: "invoice",
  status: "finalized",
  paymentStatus: "open",
  artifactStatus: "ready",
  openAmountCents: 11900,
  dueDate: "2026-10-26",
};
const TODAY = "2026-10-13";
const ds = (patch: Partial<DisplayStatusInput>, today = TODAY) => displayStatus({ ...base, ...patch }, today);

describe("display status (F04 §4.2.9)", () => {
  test("DOC-55 T-DOC-037 first matching row wins, in the order of §4.2.9", () => {
    expect(ds({ status: "draft", paymentStatus: undefined }).token).toBe("draft");
    expect(ds({ type: "cancellation", status: "sent" }).token).toBe("cancellation");
    expect(ds({ status: "cancelled", artifactStatus: "blocked" }).token).toBe("cancelled");
    expect(ds({ artifactStatus: "blocked", paymentStatus: "paid" })).toEqual({
      token: "blocked",
      label: "Gesperrt (E-Rechnung)",
    });
    expect(ds({ type: "quote", status: "accepted", paymentStatus: undefined }).label).toBe("Angenommen");
    expect(ds({ type: "delivery_note", status: "accepted", paymentStatus: undefined }).label).toBe("Erhalten");
    expect(ds({ paymentStatus: "paid", openAmountCents: 0, dueDate: "2026-01-01" }).token).toBe("paid");
    expect(ds({ type: "correction", paymentStatus: "paid" }).label).toBe("Erstattet");
    expect(ds({ paymentStatus: "written_off" }).token).toBe("written_off");
    expect(ds({ openAmountCents: -500 }).token).toBe("refund_open");
    expect(ds({ dueDate: "2026-10-12" })).toEqual({ token: "overdue", label: "Überfällig" });
    expect(ds({ dueDate: "2026-10-12", paymentStatus: "partially_paid" })).toEqual({
      token: "overdue",
      label: "Überfällig",
      partiallyPaid: true,
    });
    expect(ds({ paymentStatus: "partially_paid" }).token).toBe("partially_paid");
    expect(ds({ status: "sent" })).toEqual({ token: "open", label: "Offen" });
    expect(ds({})).toEqual({ token: "unsent", label: "Nicht versendet" });
  });

  test("INV-02 overdue is derived from today in Europe/Berlin and never stored: due today is not overdue", () => {
    expect(ds({ status: "sent", dueDate: TODAY }).token).toBe("open");
    expect(ds({ status: "sent", dueDate: TODAY }, "2026-10-14").token).toBe("overdue");
  });
});
