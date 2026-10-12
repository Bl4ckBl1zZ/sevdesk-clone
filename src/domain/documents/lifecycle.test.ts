import { describe, expect, test } from "vitest";
import {
  canTransition,
  LIFECYCLE_EVENTS,
  type LifecycleEvent,
  SALES_DOC_STATUSES,
  type SalesDocStatus,
  statusesOf,
  transition,
} from "./lifecycle";
import type { SalesDocType } from "./snapshot";

const INVOICE_ALLOWED: ReadonlyArray<[SalesDocStatus, LifecycleEvent, SalesDocStatus | null]> = [
  ["draft", "finalize", "finalized"],
  ["draft", "delete", null],
  ["finalized", "mark_sent", "sent"],
  ["finalized", "cancel", "cancelled"],
  ["sent", "retract_mark", "finalized"],
  ["sent", "cancel", "cancelled"],
];

describe("document state machines (F04 §4.2, DOC-02)", () => {
  test("DOC-02 INV-02 T-DOC-001 every (state, event) pair of the invoice family is allowed exactly as §4.2.5", () => {
    for (const type of ["invoice", "advance_invoice", "partial_invoice", "final_invoice"] as SalesDocType[]) {
      for (const from of SALES_DOC_STATUSES) {
        for (const event of LIFECYCLE_EVENTS) {
          const row = INVOICE_ALLOWED.find(([f, e]) => f === from && e === event);
          const r = transition(type, from, event);
          if (row) {
            expect(r, `${type} ${from} --${event}`).toEqual({ ok: true, value: row[2] });
          } else {
            expect(r.ok, `${type} ${from} --${event} must be illegal`).toBe(false);
            if (!r.ok) expect(r.error.code).toBe("illegal_transition");
          }
        }
      }
    }
  });

  test("INV-02 there is no reset to draft and a cancelled invoice is terminal", () => {
    for (const from of SALES_DOC_STATUSES) {
      for (const event of LIFECYCLE_EVENTS) {
        const r = transition("invoice", from, event);
        if (r.ok) expect(r.value).not.toBe("draft");
      }
    }
    for (const event of LIFECYCLE_EVENTS) expect(canTransition("invoice", "cancelled", event)).toBe(false);
  });

  test("DOC-02 illegal_transition carries a German message and the attempted pair", () => {
    const r = transition("invoice", "finalized", "finalize");
    expect(r).toEqual({
      ok: false,
      error: {
        code: "illegal_transition",
        message: "Diese Aktion ist für ein Dokument im Status „fertiggestellt“ nicht möglich.",
        params: { type: "invoice", from: "finalized", event: "finalize" },
      },
    });
  });

  test("EC-075 a Storno is created finalised and can only be marked as sent or retracted", () => {
    expect(canTransition("cancellation", "draft", "finalize")).toBe(false);
    expect(canTransition("cancellation", "finalized", "cancel")).toBe(false);
    expect(canTransition("cancellation", "finalized", "mark_sent")).toBe(true);
    expect(canTransition("cancellation", "sent", "retract_mark")).toBe(true);
  });

  test("DOC-01 stored statuses per type follow 03 §4", () => {
    expect(statusesOf("invoice")).toEqual(["draft", "finalized", "sent", "cancelled"]);
    expect(statusesOf("cancellation")).toEqual(["finalized", "sent"]);
    expect(statusesOf("delivery_note")).toEqual(["draft", "finalized", "sent", "cancelled", "accepted", "invoiced"]);
    expect(statusesOf("proforma")).toEqual(["draft", "finalized", "sent", "cancelled", "invoiced"]);
    expect(statusesOf("quote")).toEqual([
      "draft",
      "finalized",
      "sent",
      "cancelled",
      "accepted",
      "rejected",
      "expired",
      "superseded",
      "partially_invoiced",
      "invoiced",
    ]);
  });
});
