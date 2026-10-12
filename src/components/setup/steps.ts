import type messages from "@/i18n/messages/de.json";

export type StepKey = keyof (typeof messages)["setup"]["steps"];

export interface WizardStep {
  /** Query value: `/einrichtung?schritt=<slug>` (F01 §6.1). */
  slug: string;
  key: StepKey;
  /** Steps 8 (Bank) and 9 (Layout) can be skipped with "Später" (F01 SET-002). */
  skippable: boolean;
}

/** Wizard steps in the order of F01 SET-002 (04-ui-ux §4.8). No SMTP, IMAP or payment-provider steps. */
export const WIZARD_STEPS: readonly WizardStep[] = [
  { slug: "inhaberkonto", key: "inhaberkonto", skippable: false },
  { slug: "zugriff", key: "zugriff", skippable: false },
  { slug: "e-mail", key: "email", skippable: false },
  { slug: "speicher", key: "speicher", skippable: false },
  { slug: "start", key: "start", skippable: false },
  { slug: "unternehmen", key: "unternehmen", skippable: false },
  { slug: "steuern", key: "steuern", skippable: false },
  { slug: "bank", key: "bank", skippable: true },
  { slug: "layout", key: "layout", skippable: true },
  { slug: "nummernkreise", key: "nummernkreise", skippable: false },
  { slug: "fertig", key: "fertig", skippable: false },
];

export function stepIndex(slug: string | null | undefined): number {
  const i = WIZARD_STEPS.findIndex((s) => s.slug === slug);
  return i;
}

/**
 * Resume at the first incomplete step (F01 SET-003). Progress is derived from data by the server; the wizard only
 * receives the list of completed step keys. A skipped optional step ("Später": Bank, Layout) counts as passed
 * once a later step is complete.
 */
export function resumeStep(completed: readonly StepKey[]): WizardStep {
  const done = new Set(completed);
  const lastDone = WIZARD_STEPS.reduce((acc, s, i) => (done.has(s.key) ? i : acc), -1);
  return (
    WIZARD_STEPS.find((s, i) => !done.has(s.key) && !(s.skippable && i < lastDone)) ??
    (WIZARD_STEPS.at(-1) as WizardStep)
  );
}

export function stepHref(step: WizardStep) {
  return `/einrichtung?schritt=${step.slug}` as const;
}
