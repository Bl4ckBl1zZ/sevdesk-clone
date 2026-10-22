import { describe, expect, test } from "vitest";
import { ALL_RULE_TABLES } from "../rules/registry";
import { PAYMENT_TERM_LIMITS } from "../rules/thresholds";
import type { CalendarDate } from "../time/calendar-date";
import { applyManualAmounts, computeClaim } from "./claim";
import { defaultStartOf } from "./default-start";
import {
  type EvaluationContext,
  evaluateDunning,
  evaluateInvoice,
  type InvoiceState,
  nextLevelEarliest,
  planDigest,
  type ReminderState,
  SKIP_REASON_LABEL_DE,
} from "./evaluate";
import { DEFAULT_POLICIES, paymentTermsWarning, resolvePolicyId, validatePolicy } from "./policy";

const d = (s: string) => s as CalendarDate;

const POLICIES = DEFAULT_POLICIES.map((p, i) => ({ ...p, id: i === 0 ? "b2b" : "b2c" }));
const ctx: EvaluationContext = {
  policies: POLICIES,
  autoFinalizeReminders: false,
  defaultStartViaReminder: "after_printed_deadline",
  bankDataCurrent: true,
};

const inv = (over: Partial<InvoiceState> = {}): InvoiceState => ({
  invoiceId: "i1",
  number: "RE-2026-0001",
  openAmountCents: 119_000,
  dueDate: d("2026-09-01"),
  zugang: d("2026-08-02"),
  hasB2c286Note: false,
  blocked: false,
  disputed: false,
  contact: { isConsumer: false, blocked: false, calendarDueDateAgreed: false },
  reminders: [],
  paymentSignal: false,
  history: { principalCents: 119_000, changes: [] },
  ...over,
});

const reminder = (over: Partial<ReminderState>): ReminderState => ({
  id: "r1",
  level: 1,
  number: "MA-2026-0001",
  documentDate: d("2026-09-08"),
  finalizedOn: d("2026-09-08"),
  newDueDate: d("2026-09-15"),
  newDueDays: 7,
  status: "sent",
  zugang: d("2026-09-08"),
  ...over,
});

describe("DUN-001 DUN-002 MAHN-04 policies", () => {
  test("DUN-001 §4.6 seeded defaults: B2B 7/14/14 with the 40 € on level 2, B2C 7/17/21 with 2,50 € on level 3", () => {
    const [b2b, b2c] = DEFAULT_POLICIES;
    expect(
      b2b?.steps.map((s) => [s.level, s.daysAfter, s.title, s.feeCents, s.addInterest, s.addFlatFee40, s.newDueDays]),
    ).toEqual([
      [1, 7, "Zahlungserinnerung", 0, false, false, 7],
      [2, 14, "1. Mahnung", 0, true, true, 7],
      [3, 14, "Letzte Mahnung", 0, true, false, 7],
    ]);
    expect(b2c?.steps.map((s) => [s.daysAfter, s.feeCents, s.addFlatFee40, s.newDueDays])).toEqual([
      [7, 0, false, 10],
      [17, 0, false, 10],
      [21, 250, false, 10],
    ]);
    expect(DEFAULT_POLICIES.every((p) => p.steps.every((s) => !s.autoFinalize) && p.minOpenAmountCents === 500)).toBe(
      true,
    );
    expect(DEFAULT_POLICIES.flatMap((p) => validatePolicy(p)).filter((f) => f.severity === "E")).toEqual([]);
  });

  test("DUN-002 resolution: contact policy → default by consumer flag", () => {
    expect(resolvePolicyId(POLICIES, { isConsumer: true })).toBe("b2c");
    expect(resolvePolicyId(POLICIES, { isConsumer: false })).toBe("b2b");
    expect(resolvePolicyId(POLICIES, { isConsumer: false, policyId: "b2c" })).toBe("b2c");
    expect(resolvePolicyId([], { isConsumer: false })).toBeNull();
  });

  test("MAHN-03 EC-DUN-01 EC-DUN-06 EC-DUN-07 T05-104 policy checks: 40 € for consumers blocks; high B2C fee and own fee after the 40 € warn", () => {
    const b2c = { ...(DEFAULT_POLICIES[1] as (typeof DEFAULT_POLICIES)[number]) };
    const steps = b2c.steps.map((s) => (s.level === 3 ? { ...s, feeCents: 750, addFlatFee40: true } : s));
    const f = validatePolicy({ ...b2c, steps });
    expect(f.map((x) => [x.code, x.severity])).toEqual(
      expect.arrayContaining([
        ["flat_fee_consumer", "E"],
        ["b2c_fee_high", "W"],
      ]),
    );
    const b2b = DEFAULT_POLICIES[0] as (typeof DEFAULT_POLICIES)[number];
    const own = validatePolicy({ ...b2b, steps: b2b.steps.map((s) => (s.level === 3 ? { ...s, feeCents: 500 } : s)) });
    expect(own.find((x) => x.code === "own_fee_with_flat_fee")?.message).toBe(
      "Eigene Mahnkosten werden auf die 40-€-Pauschale angerechnet (§ 288 Abs. 5 S. 3 BGB).",
    );
  });

  test("MAHN-04 EC-DUE-05 T05-085 terms of 45 days for a public customer warn; 45 days B2B do not", () => {
    const d = "2026-10-12" as CalendarDate;
    expect(paymentTermsWarning(45, { isConsumer: false, isPublicAuthority: true }, d)?.code).toBe("long_terms");
    expect(paymentTermsWarning(45, { isConsumer: false }, d)).toBeNull();
    expect(paymentTermsWarning(61, { isConsumer: false }, d)?.rule).toBe("MAHN-04");
  });

  test("MAHN-06 the payment-term limits are date-effective data; an override (e.g. a 30-day EU maximum) changes the warning", () => {
    const d = "2026-10-12" as CalendarDate;
    expect(PAYMENT_TERM_LIMITS.id).toBe("payment_term_limits");
    expect(ALL_RULE_TABLES).toContain(PAYMENT_TERM_LIMITS);
    const eu = [
      {
        id: "eu-lpr",
        validFrom: "2026-01-01" as CalendarDate,
        value: { businessMaxDays: 30, publicAuthorityMaxDays: 30 },
        source: "EU-Zahlungsverzugsverordnung (angenommen)",
      },
    ];
    expect(paymentTermsWarning(45, { isConsumer: false }, d, eu)?.code).toBe("long_terms");
    expect(paymentTermsWarning(45, { isConsumer: false }, d)).toBeNull();
    expect(paymentTermsWarning(400, { isConsumer: true }, d)).toBeNull();
  });
});

describe("DUN-023…026 MAHN-02 MAHN-03 claims", () => {
  const step2 = DEFAULT_POLICIES[0]?.steps[1] as NonNullable<(typeof DEFAULT_POLICIES)[0]["steps"][1]>;

  test("MAHN-03 T05-101 B2B level 2 in default adds interest and 40 €; with flatFeeCharged the 40 € is shown as already claimed", () => {
    const start = defaultStartOf({
      dueDate: d("2026-05-31"),
      invoiceZugang: d("2026-05-31"),
      isConsumer: false,
      hasB2c286Note: false,
      calendarDueDateAgreed: true,
      reminders: [],
      route: "after_printed_deadline",
    });
    const base = {
      date: d("2026-07-31"),
      step: step2,
      isConsumer: false,
      defaultStart: start,
      openAmountCents: 1_000_000,
      history: { principalCents: 1_000_000, changes: [] },
      flatFeeCharged: false,
    };
    const r = computeClaim(base);
    expect(r.ok && [r.value.interestCents, r.value.flatFee40Cents, r.value.totalCents]).toEqual([
      17_376, 4000, 1_021_376,
    ]);
    expect(r.ok && r.value.interestSegments.length).toBe(2);
    expect(r.ok && r.value.newDueDate).toBe("2026-08-07");
    const again = computeClaim({ ...base, flatFeeCharged: true });
    expect(again.ok && [again.value.flatFee40Cents, again.value.flatFeeAlreadyClaimed]).toEqual([0, true]);
  });

  test("MAHN-01 EC-DUN-04 EC-DUN-05 T05-103 before the default start fees, interest and the 40 € are 0", () => {
    const r = computeClaim({
      date: d("2026-09-08"),
      step: { ...step2, feeCents: 500 },
      isConsumer: false,
      defaultStart: null,
      openAmountCents: 119_000,
      history: { principalCents: 119_000, changes: [] },
      flatFeeCharged: false,
    });
    expect(r.ok && [r.value.inDefault, r.value.feeCents, r.value.interestCents, r.value.flatFee40Cents]).toEqual([
      false,
      0,
      0,
      0,
    ]);
  });

  test("MAHN-03 EC-DUN-01 EC-DUN-02 EC-DUN-04 EC-DUN-05 EC-DUN-08 T05-105 manual amounts", () => {
    const claim = {
      level: 2,
      title: "1. Mahnung",
      inDefault: false,
      feeCents: 0,
      interestCents: 1000,
      interestSegments: [],
      flatFee40Cents: 0,
      flatFeeAlreadyClaimed: false,
      openAmountCents: 100_000,
      newDueDate: d("2026-10-23"),
      totalCents: 101_000,
      defaultStartDate: d("2026-10-20"),
    };
    const at = { isConsumer: true, flatFeeCharged: false, date: d("2026-10-16") };
    expect(applyManualAmounts(claim, { includeFlatFee: true }, at).findings[0]?.message).toBe(
      "Die 40-€-Pauschale kann nur gegenüber Unternehmern geltend gemacht werden (§ 288 Abs. 5 BGB).",
    );
    expect(
      applyManualAmounts(
        claim,
        { includeFlatFee: true },
        { ...at, isConsumer: false, flatFeeCharged: true, flatFeeReminderNumber: "MA-2026-0004" },
      ).findings[0]?.message,
    ).toBe("Die 40-€-Pauschale wurde für diese Forderung bereits mit Mahnung MA-2026-0004 geltend gemacht.");
    expect(applyManualAmounts(claim, { includeFlatFee: true }, { ...at, isConsumer: false }).findings[0]?.message).toBe(
      "Die Pauschale setzt Verzug voraus. Verzug beginnt am 20.10.2026.",
    );
    const fee = applyManualAmounts(claim, { feeCents: 750 }, at).findings.map((f) => [f.code, f.severity]);
    expect(fee).toEqual([
      ["not_in_default", "W"],
      ["b2c_fee_high", "W"],
    ]);
    const raised = applyManualAmounts({ ...claim, inDefault: true }, { interestCents: 1500 }, at);
    expect(raised.findings.map((f) => [f.code, f.severity])).toEqual([["interest_above_computed", "E"]]);
    expect(raised.findings[0]?.message).toMatch(
      /^Die Zinsen übersteigen den berechneten Betrag \(10,00\s€\)\. Bitte Grund angeben\.$/,
    );
    const reasoned = applyManualAmounts(
      { ...claim, inDefault: true },
      { interestCents: 1500, interestReason: "Bankauskunft" },
      at,
    );
    expect(reasoned.findings).toEqual([]);
    expect(reasoned.claim.totalCents).toBe(101_500);
  });
});

describe("DUN-030 DUN-033 DUN-054 DUN-055 DUN-057 evaluateDunning (§4.5)", () => {
  const today = d("2026-10-16");

  test.each<[string, Partial<InvoiceState>, string]>([
    [
      "no policy",
      { contact: { isConsumer: true, blocked: false, calendarDueDateAgreed: false, policyId: "x" } },
      "create_draft",
    ],
    ["PAY-064 EC-DUN-31 not marked sent", { zugang: undefined }, "not_marked_sent"],
    [
      "DUN-002 contact „Nicht mahnen“",
      { contact: { isConsumer: false, blocked: true, calendarDueDateAgreed: false } },
      "excluded",
    ],
    ["DUN-002 invoice „Nicht mahnen“", { blocked: true }, "excluded"],
    ["DUN-034 disputed", { disputed: true }, "disputed"],
    [
      "DUN-034 paused until a later day",
      { case: { status: "paused", currentLevel: 0, pausedUntil: d("2026-10-20"), flatFeeCharged: false } },
      "paused",
    ],
    ["DUN-042 handed over", { case: { status: "handed_over", currentLevel: 1, flatFeeCharged: false } }, "handed_over"],
    [
      "DUN-035 grace after reopening",
      { case: { status: "active", currentLevel: 0, graceUntil: d("2026-10-20"), flatFeeCharged: false } },
      "reopen_grace",
    ],
    ["DUN-001 below the minimum", { openAmountCents: 499 }, "below_minimum"],
    ["EC-DUN-18 EC-152 payment signal", { paymentSignal: true }, "payment_signal"],
    ["EC-DUN-15 time-barred", { dueDate: d("2022-06-01"), zugang: d("2022-05-20") }, "time_barred"],
    ["level 1 not yet due", { dueDate: d("2026-10-12") }, "not_due_yet"],
  ])("DUN-033 T05-123 %s", (_name, over, expected) => {
    const a = evaluateInvoice(today, inv(over), ctx);
    expect(a.kind === "skip" ? a.reason : a.kind).toBe(expected);
  });

  test("DUN-033 T05-123 no matching policy at all → no_policy", () => {
    const a = evaluateInvoice(today, inv(), { ...ctx, policies: [] });
    expect(a.kind === "skip" && a.reason).toBe("no_policy");
  });

  test("DUN-055 EC-DUN-32 T05-169 finalised unmarked reminder blocks the next level; after 2 days todo_mark_sent once", () => {
    const r = reminder({ status: "finalized", zugang: undefined, finalizedOn: d("2026-10-15") });
    const a = evaluateInvoice(today, inv({ reminders: [r] }), ctx);
    expect(a.kind === "skip" && a.reason).toBe("previous_reminder_not_marked_sent");
    const later = evaluateInvoice(d("2026-10-17"), inv({ reminders: [r] }), ctx);
    expect(later.kind).toBe("todo_mark_sent");
    const logged = evaluateInvoice(d("2026-10-18"), inv({ reminders: [{ ...r, todoLogged: true }] }), ctx);
    expect(logged.kind === "skip" && logged.reason).toBe("previous_reminder_not_marked_sent");
  });

  test("DUN-054 PAY-052 T05-168 L1 dated 2026-07-01 marked by post (Zugang 07-04), L2 daysAfter 14 / newDueDays 7 → not before 2026-07-18", () => {
    const l1 = reminder({
      documentDate: d("2026-07-01"),
      finalizedOn: d("2026-07-01"),
      newDueDate: d("2026-07-08"),
      zugang: d("2026-07-04"),
    });
    expect(nextLevelEarliest(l1, 14)).toBe("2026-07-18");
    const state = inv({
      dueDate: d("2026-06-20"),
      zugang: d("2026-06-06"),
      reminders: [l1],
      case: { status: "active", currentLevel: 1, flatFeeCharged: false },
    });
    const before = evaluateInvoice(d("2026-07-17"), state, ctx);
    expect(before.kind === "skip" && before.reason).toBe("not_due_yet");
    // DUN-010: the next planned action carries its earliest date.
    expect(before.kind === "skip" && before.earliest).toBe("2026-07-18");
    const on = evaluateInvoice(d("2026-07-18"), state, ctx);
    expect(on.kind).toBe("create_draft");
    expect(on.kind === "create_draft" && on.level).toBe(2);
  });

  test("DUN-056 EC-DUN-17 next level waits for max(printed deadline, Zugang + newDueDays)", () => {
    const l1 = reminder({ documentDate: d("2026-07-01"), newDueDate: d("2026-07-30"), zugang: d("2026-07-06") });
    const state = inv({
      dueDate: d("2026-06-20"),
      reminders: [l1],
      case: { status: "active", currentLevel: 1, flatFeeCharged: false },
    });
    const a = evaluateInvoice(d("2026-07-25"), state, ctx);
    expect(a.kind === "skip" && [a.reason, a.detail]).toEqual(["previous_deadline_running", "30.07.2026"]);
  });

  test("DUN-030 EC-DUN-30 T05-134 last level reached; policy change keeps the level and takes the next higher step", () => {
    const rs = [1, 2, 3].map((level) => reminder({ id: `r${level}`, level }));
    const a = evaluateInvoice(
      today,
      inv({ reminders: rs, case: { status: "active", currentLevel: 3, flatFeeCharged: true } }),
      ctx,
    );
    expect(a.kind === "skip" && a.reason).toBe("last_level_reached");
  });

  test("DUN-057 EC-DUN-19 T05-171 auto-finalise needs the global switch, the step flag and fresh bank data", () => {
    const auto = POLICIES.map((p) => ({ ...p, steps: p.steps.map((s) => ({ ...s, autoFinalize: true })) }));
    expect(evaluateInvoice(today, inv(), { ...ctx, policies: auto }).kind).toBe("create_draft");
    expect(evaluateInvoice(today, inv(), { ...ctx, policies: auto, autoFinalizeReminders: true }).kind).toBe(
      "finalize",
    );
    const stale = evaluateInvoice(today, inv(), {
      ...ctx,
      policies: auto,
      autoFinalizeReminders: true,
      bankDataCurrent: false,
      bankDataNote: "letzter Kontoauszug bis 01.10.2026",
    });
    expect(stale.kind).toBe("create_draft");
    expect(stale.kind === "create_draft" && stale.notes[0]).toBe(
      "Bankdaten nicht aktuell (letzter Kontoauszug bis 01.10.2026) – nur Entwurf.",
    );
  });

  test("DUN-030 an existing draft is not duplicated; the plan digest is stable", () => {
    const draft = reminder({ status: "draft", zugang: undefined, finalizedOn: undefined });
    const a = evaluateInvoice(today, inv({ reminders: [draft] }), ctx);
    expect(a.kind === "skip" && a.reason).toBe("draft_pending");
    const plan = evaluateDunning(today, [inv(), inv({ invoiceId: "i0", zugang: undefined })], ctx);
    expect(planDigest(plan)).toBe(planDigest([...plan].reverse()));
  });
});

describe("F05 §5.2 dunning edge cases (pure)", () => {
  const today = d("2026-10-16");
  const atLevel2 = (invoiceId: string, flatFeeCharged = false) =>
    inv({
      invoiceId,
      number: `RE-2026-000${invoiceId.slice(1)}`,
      reminders: [reminder({ id: `${invoiceId}-r1` })],
      case: { status: "active", currentLevel: 1, flatFeeCharged },
    });

  test("EC-DUN-03 MAHN-03 two invoices of the same customer in default: the 40 € once per invoice (per claim)", () => {
    const [a, b] = evaluateDunning(today, [atLevel2("i1"), atLevel2("i2")], ctx);
    for (const x of [a, b]) {
      expect(x?.kind).toBe("create_draft");
      expect(x?.kind === "create_draft" && [x.level, x.claim.inDefault, x.claim.flatFee40Cents]).toEqual([
        2,
        true,
        4000,
      ]);
    }
    // the first claim already carries its 40 € — the second still gets its own
    const [c, e] = evaluateDunning(today, [atLevel2("i1", true), atLevel2("i2")], ctx);
    expect(c?.kind === "create_draft" && [c.claim.flatFee40Cents, c.claim.flatFeeAlreadyClaimed]).toEqual([0, true]);
    expect(e?.kind === "create_draft" && e.claim.flatFee40Cents).toBe(4000);
  });

  test("EC-DUN-18 EC-152 an unconfirmed match / incoming payment signal skips the invoice with the review hint", () => {
    const a = evaluateInvoice(today, inv({ paymentSignal: true }), ctx);
    expect(a).toMatchObject({ kind: "skip", reason: "payment_signal", level: 1 });
    expect(SKIP_REASON_LABEL_DE.payment_signal).toBe("Zahlung möglicherweise eingegangen – Zuordnung prüfen.");
    expect(evaluateInvoice(today, inv({ paymentSignal: false }), ctx).kind).toBe("create_draft");
  });
});
