/**
 * Setup wizard progress derived from data (F01 SET-003: "progress is derived from data, not stored separately";
 * §4.1 state machine). Pure: the Convex query collects the facts, this decides which steps are complete.
 */
import { companySchema, taxSchema } from "../schemas/settings";
import type { CalendarDate } from "../time/calendar-date";
import { type CompanySettingsData, companyFormFromProfile, type TaxSettingsData, taxFormFromProfile } from "./profile";

export const SETUP_STEPS = [
  "inhaberkonto",
  "zugriff",
  "email",
  "speicher",
  "start",
  "unternehmen",
  "steuern",
  "bank",
  "layout",
  "nummernkreise",
  "fertig",
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupFacts {
  /** The owner has ≥ 1 passkey (SET-009). */
  ownerPasskeys: number;
  /** Server location and access concept recorded (SET-007). */
  accessConfirmed: boolean;
  /** An auth mail was delivered (bootstrap code or test code, SET-009a). */
  authMailDelivered: boolean;
  /** Last R2 checkpoint bucket test succeeded (SET-009b). */
  checkpointStorageOk: boolean;
  profile: (CompanySettingsData & TaxSettingsData) | null;
  bankAccounts: number;
  layouts: number;
  numberRanges: number;
  setupCompletedAt?: number;
}

export function completedSteps(facts: SetupFacts, today: CalendarDate): SetupStep[] {
  const done = new Set<SetupStep>();
  if (facts.ownerPasskeys > 0) done.add("inhaberkonto");
  if (facts.accessConfirmed) done.add("zugriff");
  if (facts.authMailDelivered) done.add("email");
  if (facts.checkpointStorageOk) done.add("speicher");
  // "Start" is a choice without data: done once the steps before it are.
  if (["inhaberkonto", "zugriff", "email", "speicher"].every((s) => done.has(s as SetupStep))) done.add("start");
  const company = facts.profile ? companyFormFromProfile(facts.profile) : undefined;
  if (company && companySchema.safeParse(company).success) done.add("unternehmen");
  const tax = facts.profile ? taxFormFromProfile(facts.profile, today) : undefined;
  if (tax && taxSchema.safeParse(tax).success) done.add("steuern");
  if (facts.bankAccounts > 0) done.add("bank");
  if (facts.layouts > 0) done.add("layout");
  if (facts.numberRanges > 0) done.add("nummernkreise");
  if (facts.setupCompletedAt !== undefined) done.add("fertig");
  return SETUP_STEPS.filter((s) => done.has(s));
}
