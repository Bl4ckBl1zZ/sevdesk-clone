/**
 * Dunning policies (Mahnrichtlinien) — F05 DUN-001/002, §4.6 seeded defaults, MAHN-04/06 warnings. Pure.
 * No e-mail template and no send switch (B2): steps only create drafts or finalise (`autoFinalize`).
 */

export interface PolicyStep {
  readonly level: number;
  /** Level 1: days after the due date; later levels: days after the previous reminder's Zugang (DUN-054). */
  readonly daysAfter: number;
  readonly title: string;
  readonly feeCents: number;
  readonly addInterest: boolean;
  /** B2B only, once per claim (MAHN-03). */
  readonly addFlatFee40: boolean;
  readonly newDueDays: number;
  readonly textTemplateId?: string | undefined;
  readonly autoFinalize: boolean;
}

export interface DunningPolicy {
  readonly name: string;
  readonly isDefault: boolean;
  readonly appliesTo: { readonly consumer: boolean; readonly business: boolean };
  readonly steps: readonly PolicyStep[];
  /** „Bald fällig“ horizon (DUN-053, default 3). */
  readonly dueSoonDays?: number | undefined;
  readonly dueSoonTodo: boolean;
  readonly minOpenAmountCents: number;
  readonly pauseOnPartialPaymentDays: number;
  readonly stopAfterLastLevel: boolean;
}

const step = (
  level: number,
  daysAfter: number,
  title: string,
  feeCents: number,
  addInterest: boolean,
  addFlatFee40: boolean,
  newDueDays: number,
): PolicyStep => ({ level, daysAfter, title, feeCents, addInterest, addFlatFee40, newDueDays, autoFinalize: false });

/** §4.6 seeded default policies (values reproduce 7/21/35 resp. 7/24/45 days after due with same-day marks). */
export const DEFAULT_POLICIES: readonly DunningPolicy[] = [
  {
    name: "Standard B2B",
    isDefault: true,
    appliesTo: { consumer: false, business: true },
    steps: [
      step(1, 7, "Zahlungserinnerung", 0, false, false, 7),
      step(2, 14, "1. Mahnung", 0, true, true, 7),
      step(3, 14, "Letzte Mahnung", 0, true, false, 7),
    ],
    dueSoonDays: 3,
    dueSoonTodo: false,
    minOpenAmountCents: 500,
    pauseOnPartialPaymentDays: 14,
    stopAfterLastLevel: true,
  },
  {
    name: "Standard B2C",
    isDefault: true,
    appliesTo: { consumer: true, business: false },
    steps: [
      step(1, 7, "Zahlungserinnerung", 0, false, false, 10),
      step(2, 17, "1. Mahnung", 0, true, false, 10),
      step(3, 21, "Letzte Mahnung", 250, true, false, 10),
    ],
    dueSoonDays: 3,
    dueSoonTodo: false,
    minOpenAmountCents: 500,
    pauseOnPartialPaymentDays: 14,
    stopAfterLastLevel: true,
  },
];

export interface PolicyRef {
  readonly id: string;
  readonly isDefault: boolean;
  readonly appliesTo: { readonly consumer: boolean; readonly business: boolean };
}

/** DUN-002: contact setting → default policy for B2C/B2B (by `contact.isConsumer`). */
export function resolvePolicyId(
  policies: readonly PolicyRef[],
  contact: { readonly isConsumer: boolean; readonly policyId?: string | undefined },
): string | null {
  if (contact.policyId && policies.some((p) => p.id === contact.policyId)) return contact.policyId;
  const fits = (p: PolicyRef) => (contact.isConsumer ? p.appliesTo.consumer : p.appliesTo.business);
  return policies.find((p) => p.isDefault && fits(p))?.id ?? policies.find(fits)?.id ?? null;
}

/** EC-DUN-30: the next step is the first with a level above the case's current level. */
export const nextStepOf = (policy: Pick<DunningPolicy, "steps">, currentLevel: number): PolicyStep | null =>
  [...policy.steps].sort((a, b) => a.level - b.level).find((s) => s.level > currentLevel) ?? null;

export interface PolicyFinding {
  readonly code: string;
  readonly severity: "E" | "W";
  readonly message: string;
  readonly field?: string;
  readonly rule?: string;
}

export const MSG = {
  flatFeeConsumer: "Die 40-€-Pauschale kann nur gegenüber Unternehmern geltend gemacht werden (§ 288 Abs. 5 BGB).",
  b2cFee: "Gegenüber Verbrauchern sind nur die tatsächlich entstandenen Mahnkosten ersatzfähig (üblich 2–5 €).",
  ownFeeWithFlat: "Eigene Mahnkosten werden auf die 40-€-Pauschale angerechnet (§ 288 Abs. 5 S. 3 BGB).",
  longTerms:
    "Zahlungsziele über 60 Tage (B2B) bzw. 30 Tage (öffentliche Auftraggeber) sind nur bei ausdrücklicher Vereinbarung wirksam (§ 271a BGB).",
} as const;

/** B2C: fees above this amount draw EC-DUN-06 (only actual costs). */
export const B2C_FEE_WARNING_CENTS = 500;

/** DUN-001 / DUN-025 / MAHN-04 checks of a policy (the UI shows warnings, errors block saving). */
export function validatePolicy(p: DunningPolicy): PolicyFinding[] {
  const out: PolicyFinding[] = [];
  if (!p.name.trim())
    out.push({ code: "name_required", severity: "E", message: "Bitte einen Namen angeben.", field: "name" });
  if (!p.appliesTo.consumer && !p.appliesTo.business) {
    out.push({
      code: "applies_to_required",
      severity: "E",
      message: "Die Richtlinie muss für Verbraucher oder Unternehmen gelten.",
      field: "appliesTo",
    });
  }
  if (p.steps.length === 0) {
    out.push({ code: "steps_required", severity: "E", message: "Mindestens eine Mahnstufe anlegen.", field: "steps" });
  }
  const levels = p.steps.map((s) => s.level);
  if (new Set(levels).size !== levels.length || levels.some((l, i) => l !== i + 1)) {
    out.push({
      code: "levels_sequence",
      severity: "E",
      message: "Die Mahnstufen müssen fortlaufend ab 1 nummeriert sein.",
      field: "steps",
    });
  }
  let flatClaimed = false;
  for (const [i, s] of p.steps.entries()) {
    const f = `steps.${i}`;
    if (s.daysAfter < 0 || s.newDueDays < 1 || s.feeCents < 0) {
      out.push({
        code: "step_values",
        severity: "E",
        message: `Stufe ${s.level}: Tage, Frist und Gebühr dürfen nicht negativ sein (Frist mindestens 1 Tag).`,
        field: f,
      });
    }
    if (!s.title.trim()) {
      out.push({ code: "step_title", severity: "E", message: `Stufe ${s.level}: Titel fehlt.`, field: `${f}.title` });
    }
    if (s.addFlatFee40 && p.appliesTo.consumer) {
      out.push({
        code: "flat_fee_consumer",
        severity: "E",
        message: MSG.flatFeeConsumer,
        field: `${f}.addFlatFee40`,
        rule: "MAHN-03",
      });
    }
    if (p.appliesTo.consumer && s.feeCents > B2C_FEE_WARNING_CENTS) {
      out.push({ code: "b2c_fee_high", severity: "W", message: MSG.b2cFee, field: `${f}.feeCents`, rule: "MAHN-05" });
    }
    flatClaimed = flatClaimed || s.addFlatFee40;
    if (p.appliesTo.business && flatClaimed && s.feeCents > 0) {
      out.push({
        code: "own_fee_with_flat_fee",
        severity: "W",
        message: MSG.ownFeeWithFlat,
        field: `${f}.feeCents`,
        rule: "MAHN-03",
      });
    }
    if (s.newDueDays > 60) {
      out.push({
        code: "long_terms",
        severity: "W",
        message: MSG.longTerms,
        field: `${f}.newDueDays`,
        rule: "MAHN-04",
      });
    }
  }
  if (p.minOpenAmountCents < 0 || p.pauseOnPartialPaymentDays < 0 || (p.dueSoonDays ?? 0) < 0) {
    out.push({ code: "policy_values", severity: "E", message: "Beträge und Tage dürfen nicht negativ sein." });
  }
  return out;
}

/** PAY-054 / EC-DUE-05 (MAHN-04): payment terms on a contact or policy. */
export function paymentTermsWarning(
  dueDays: number,
  contact: { readonly isConsumer: boolean; readonly isPublicAuthority?: boolean | undefined },
): PolicyFinding | null {
  if (contact.isConsumer) return null;
  const limit = contact.isPublicAuthority ? 30 : 60;
  return dueDays > limit ? { code: "long_terms", severity: "W", message: MSG.longTerms, rule: "MAHN-04" } : null;
}
