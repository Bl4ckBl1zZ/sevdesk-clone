import { describe, expect, test } from "vitest";
import {
  caseActionValues,
  interestValues,
  policyValues,
  policyWire,
  reminderCreateValues,
  reminderFinalizeArgs,
  serializePolicy,
  serializeReminderFinalizeCheck,
} from "./dunning";

/** 05 §4.3 reminders / F05 dunning on the wire: request mapping and the finalize preview shared by REST and MCP. */

describe("reminder requests (DUN-004, DUN-008)", () => {
  test("DUN-008 a reminder draft maps level, fees, interest with reason, flat fee, new due date and texts when given", () => {
    expect(reminderCreateValues({})).toEqual({});
    expect(
      reminderCreateValues({
        level: 2,
        fee_cents: 500,
        interest_cents: 1_234,
        interest_reason: "Zinsen ab Verzugseintritt",
        include_flat_fee: false,
        new_due_date: "2026-11-01",
        head_text: "",
        foot_text: "Mit freundlichen Grüßen",
        acknowledge_warnings: ["fee_above_policy"],
      }),
    ).toEqual({
      level: 2,
      feeCents: 500,
      interestCents: 1_234,
      interestReason: "Zinsen ab Verzugseintritt",
      includeFlatFee: false,
      newDueDate: "2026-11-01",
      headText: "",
      footText: "Mit freundlichen Grüßen",
      acknowledgeWarnings: ["fee_above_policy"],
    });
  });

  test("DUN-004 MCP-006 finalize arguments sort and dedupe the acknowledged codes so the confirm token is order-free", () => {
    expect(reminderFinalizeArgs("r1", {})).toEqual({ id: "r1" });
    expect(reminderFinalizeArgs("r1", { version: 4, acknowledge_warnings: ["b", "a", "b"] })).toEqual({
      id: "r1",
      version: 4,
      acknowledgeWarnings: ["a", "b"],
    });
  });

  test("DUN-034 DUN-042 case actions carry reason, pause date, partner and acknowledged codes only when set", () => {
    expect(caseActionValues({ action: "resume" })).toEqual({ action: "resume" });
    expect(
      caseActionValues({
        action: "hand_over",
        reason: "keine Reaktion",
        until: "2026-12-01",
        partner: "Inkasso Nord GmbH",
        acknowledge_warnings: ["time_barred"],
      }),
    ).toEqual({
      action: "hand_over",
      reason: "keine Reaktion",
      until: "2026-12-01",
      partner: "Inkasso Nord GmbH",
      acknowledgeWarnings: ["time_barred"],
    });
  });

  test("DUN-022 the interest margin is b2b, b2c or explicit basis points", () => {
    const q = { amount_cents: 100_000, from: "2026-01-01", to: "2026-12-31" };
    expect(interestValues({ ...q, margin: "b2c" }).margin).toBe("b2c");
    expect(interestValues({ ...q, margin: "b2b" }).margin).toBe("b2b");
    expect(interestValues({ ...q, margin: "-150" })).toEqual({
      ...{ amountCents: 100_000 },
      from: q.from,
      to: q.to,
      margin: -150,
    });
  });
});

describe("reminder finalize preview (DUN-004)", () => {
  const check = {
    reminder: { status: "draft", version: 3, level: 2 },
    findings: [
      { code: "time_barred", severity: "W", message: "Die Forderung ist möglicherweise verjährt." },
      { code: "time_barred", severity: "W", message: "doppelt" },
    ],
    claim: {
      openAmountCents: 119_000,
      feeCents: 500,
      interestCents: 1_234,
      flatFee40Cents: 4_000,
      totalCents: 124_734,
      newDueDate: "2026-11-01",
      inDefault: true,
      defaultStartDate: "2026-09-15",
    },
    today: "2026-10-18",
  };

  test("DUN-004 DUN-041 an unacknowledged ⚑ warning blocks; acknowledged it is allowed and the claim is shown", () => {
    const blocked = serializeReminderFinalizeCheck("rem_x", check, []);
    expect(blocked).toMatchObject({
      allowed: false,
      unacknowledged_warnings: ["time_barred"],
      document_date: "2026-10-18",
    });
    const ok = serializeReminderFinalizeCheck("rem_x", check, ["time_barred"]);
    expect(ok).toMatchObject({
      allowed: true,
      errors: [],
      claim: { level: 2, total_cents: 124_734, flat_fee_40_cents: 4_000, in_default: true },
    });
  });

  test("DUN-004 an error finding or a claim that cannot be computed blocks the finalisation", () => {
    const err = serializeReminderFinalizeCheck(
      "rem_x",
      {
        ...check,
        findings: [{ code: "invoice_paid", severity: "E", message: "Die Rechnung ist bezahlt." }],
        claim: null,
      },
      [],
    );
    expect(err).toMatchObject({
      allowed: false,
      claim: null,
      errors: [{ code: "invoice_paid", rule: null, field: null, message: "Die Rechnung ist bezahlt." }],
    });
  });
});

describe("dunning policies on the wire (DUN-001)", () => {
  const wire = policyWire.parse({
    name: "B2B Standard",
    is_default: true,
    applies_to: { consumer: false, business: true },
    steps: [
      {
        level: 1,
        days_after: 14,
        title: "Zahlungserinnerung",
        fee_cents: 0,
        add_interest: false,
        add_flat_fee_40: false,
        new_due_days: 7,
        auto_finalize: false,
      },
    ],
    due_soon_days: 3,
    due_soon_todo: true,
    min_open_amount_cents: 500,
    pause_on_partial_payment_days: 14,
    stop_after_last_level: true,
  });

  test("DUN-001 a policy round-trips wire → values → wire; seeded defaults have no ID and warnings are listed", () => {
    const values = policyValues(wire);
    expect(values).toMatchObject({ name: "B2B Standard", dueSoonDays: 3, steps: [{ daysAfter: 14, newDueDays: 7 }] });
    const stored = serializePolicy({ ...values, id: "k57f3x2m9q8w1e4r6t", seeded: false, version: 2 });
    expect(stored).toMatchObject({ ...wire, id: "dpo_k57f3x2m9q8w1e4r6t", seeded: false, version: 2, warnings: [] });
    const { due_soon_days: _d, ...noDueSoon } = wire;
    const seeded = serializePolicy({
      ...policyValues(noDueSoon),
      id: "seed",
      seeded: true,
      version: 0,
      warnings: [{ code: "no_flat_fee", message: "Ohne 40-€-Pauschale." }],
    });
    expect(seeded.id).toBeNull();
    expect(seeded).not.toHaveProperty("due_soon_days");
    expect(seeded.warnings).toEqual([{ code: "no_flat_fee", message: "Ohne 40-€-Pauschale." }]);
  });
});
