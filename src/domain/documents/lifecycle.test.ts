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

  test("QUO-03 T-QUO-012 quote transitions incl. superseded, late acceptance and reopening follow §4.2.1", () => {
    const ok = (from: SalesDocStatus, event: LifecycleEvent) => transition("quote", from, event);
    expect(ok("finalized", "supersede")).toEqual({ ok: true, value: "superseded" });
    expect(ok("rejected", "supersede")).toEqual({ ok: true, value: "superseded" });
    expect(ok("expired", "supersede")).toEqual({ ok: true, value: "superseded" });
    expect(ok("accepted", "supersede").ok).toBe(false);
    expect(ok("expired", "accept").ok).toBe(false);
    expect(ok("expired", "accept_late")).toEqual({ ok: true, value: "accepted" });
    expect(ok("rejected", "reopen")).toEqual({ ok: true, value: "sent" });
    expect(ok("accepted", "withdraw")).toEqual({ ok: true, value: "cancelled" });
    expect(ok("superseded", "withdraw").ok).toBe(false);
    expect(ok("partially_invoiced", "invoice_reverted")).toEqual({ ok: true, value: "accepted" });
    for (const event of LIFECYCLE_EVENTS) {
      expect(canTransition("quote", "superseded", event)).toBe(false);
      expect(canTransition("quote", "cancelled", event)).toBe(false);
    }
  });

  test("QUO-08 QUO-13 an order returns to sent or finalized when its invoices are cancelled", () => {
    expect(transition("order_confirmation", "partially_invoiced", "invoice_reverted")).toEqual({
      ok: true,
      value: "sent",
    });
    expect(transition("order_confirmation", "invoiced", "invoice_reverted_unsent")).toEqual({
      ok: true,
      value: "finalized",
    });
    expect(canTransition("order_confirmation", "invoiced", "withdraw")).toBe(false);
  });

  test("QUO-09 a delivery note returns to its previous status when its invoice is cancelled", () => {
    expect(transition("delivery_note", "sent", "mark_received")).toEqual({ ok: true, value: "accepted" });
    expect(transition("delivery_note", "invoiced", "invoice_reverted")).toEqual({ ok: true, value: "accepted" });
    expect(transition("delivery_note", "invoiced", "invoice_reverted_sent")).toEqual({ ok: true, value: "sent" });
    expect(transition("delivery_note", "invoiced", "invoice_reverted_unsent")).toEqual({
      ok: true,
      value: "finalized",
    });
    expect(canTransition("delivery_note", "invoiced", "withdraw")).toBe(false);
  });

  test("QUO-12 EC-DOC-102 an invoiced proforma cannot be invoiced again", () => {
    expect(transition("proforma", "sent", "invoiced_fully")).toEqual({ ok: true, value: "invoiced" });
    expect(canTransition("proforma", "invoiced", "invoiced_fully")).toBe(false);
  });
});
