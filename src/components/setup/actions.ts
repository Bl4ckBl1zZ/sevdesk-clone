"use client";

/**
 * Adapter between the setup wizard / settings pages and Convex (F01 §3.1–3.7). Every write goes to a public Convex
 * function built with the wrappers in convex/functions.ts (session + role check, audit — SET-140/142); the
 * server re-validates with the same zod schemas (src/domain/schemas/settings, SET-143). Errors are ConvexErrors
 * with a German `message` (see `adapterErrorMessage`).
 */
import { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import type {
  AccessValues,
  BankValues,
  CompanyValues,
  EmailStepValues,
  LayoutValues,
  NumberRangesValues,
  TaxValues,
} from "@/domain/schemas/settings";
import { requireConvexClient } from "@/lib/convex-client";

export type CheckStatus = "ok" | "warning" | "error" | "unknown";

export interface StatusCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** German result or remedy text. */
  detail?: string;
  /** What to do about a warning/error (F12 AUD-020). */
  remedy?: string;
  latencyMs?: number;
}

/** Wizard progress and stored values (SET-003); live via `useAuthedQuery(api.settings.getSetupState, {})`. */
export type SetupState = FunctionReturnType<typeof api.settings.getSetupState>;

export interface ChecklistItem {
  code: string;
  /** German message from validateCompanyForDocuments (SET-004/012). */
  message: string;
  /** Wizard step or settings page that fixes the item (04-ui-ux §1.5). */
  href: string;
}

export interface SetupChecklist {
  blocking: ChecklistItem[];
  warnings: ChecklistItem[];
}

/** Codes that mean "the session is gone" → the session-expired dialog opens (04 §4.9). */
export const SESSION_ERROR_CODES = new Set([
  "unauthenticated",
  "session_invalid",
  "not_a_member",
  "member_expired",
  "member_disabled",
]);

export function adapterErrorCode(error: unknown): string | undefined {
  if (error instanceof ConvexError && typeof error.data === "object" && error.data !== null) {
    return String((error.data as { code?: unknown }).code ?? "");
  }
  return undefined;
}

/** The domain reason (`COUNTER_DECREASE`, `REASON_REQUIRED`, `FORMAT_COLLISION` …) of a ConvexError, if any. */
export function adapterErrorReason(error: unknown): string | undefined {
  if (error instanceof ConvexError && typeof error.data === "object" && error.data !== null) {
    const reason = (error.data as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : undefined;
  }
  return undefined;
}

/** The German message of a ConvexError from our wrappers (never English server text). */
export function adapterErrorMessage(error: unknown): string | undefined {
  if (error instanceof ConvexError && typeof error.data === "object" && error.data !== null) {
    const message = (error.data as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

const convex = () => requireConvexClient();

/** Step 2: server location + access concept (SET-007, SET-046). */
export async function saveAccessConcept(input: AccessValues): Promise<void> {
  await convex().mutation(api.settings.saveAccessConcept, { values: input });
}

/** Step 2: live host checks (DNS, certificate, `api.` 404 for UI paths, basic auth on `convex-dash.`, RP ID). */
export async function runAccessChecks(): Promise<StatusCheck[]> {
  return convex().action(api.settings.runAccessChecks, {});
}

/** Step 3: owner notification address (default OWNER_EMAIL). */
export async function saveNotificationEmail(input: EmailStepValues): Promise<void> {
  await convex().mutation(api.settings.saveNotificationEmail, { values: input });
}

/** Step 3: "Test-Code senden" via Cloudflare Email Sending (SET-107, errors mapped per §5.9). */
export async function sendTestAuthMail(): Promise<StatusCheck> {
  const res = await convex().action(api.authMail.sendTest, {});
  return { id: "delivery", label: "Letzte Zustellung", status: res.ok ? "ok" : "error", detail: res.message };
}

/** Step 4: R2 checkpoint bucket probe write/read/delete + bucket lock + latest backup (SET-009b, SET-115). */
export async function testCheckpointStorage(): Promise<StatusCheck[]> {
  return convex().action(api.settings.testCheckpointStorage, {});
}

/** Step 6 / Einstellungen › Unternehmen (SET-010, SET-015). Creates a new companyProfile version. */
export async function saveCompanyProfile(input: CompanyValues, expectedVersion?: number): Promise<number> {
  return convex().mutation(api.settings.saveCompanyProfile, {
    values: input,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  });
}

/**
 * Step 7 / Einstellungen › Steuern (SET-030…044). `priorYearTurnover` stays the German amount string; the server
 * converts it with src/domain/money to `priorYearTotalTurnoverCents`.
 */
export async function saveTaxSettings(input: TaxValues, expectedVersion?: number): Promise<number> {
  return convex().mutation(api.settings.saveTaxSettings, {
    values: input,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  });
}

/** Step 8 / Einstellungen › Bank: manual invoice account (SET-050…053). */
export async function saveBankAccount(input: BankValues): Promise<void> {
  await convex().mutation(api.settings.saveBankAccount, { values: input });
}

/** Step 9: default layout (new layoutVersion, SET-070/071); the logo is uploaded to Convex storage first (SET-018). */
export async function saveLayout(input: LayoutValues & { logo?: File | null }): Promise<void> {
  const { logo, ...values } = input;
  let logoStorageId: string | undefined;
  if (logo) {
    const uploadUrl = await convex().mutation(api.settings.generateLogoUploadUrl, {});
    const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": logo.type }, body: logo });
    if (!res.ok) throw new Error("Das Logo konnte nicht hochgeladen werden.");
    logoStorageId = ((await res.json()) as { storageId: string }).storageId;
  }
  await convex().mutation(api.settings.saveLayout, {
    values,
    ...(logoStorageId ? { logoStorageId: logoStorageId as never } : {}),
  });
}

/** Step 10 / Einstellungen › Nummernkreise: formats and next values (SET-006, SET-055…060). */
export async function saveNumberRanges(input: NumberRangesValues): Promise<void> {
  await convex().mutation(api.settings.saveNumberRanges, { values: input });
}

/** Step 11: checklist from validateCompanyForDocuments (SET-004). */
export async function getSetupChecklist(): Promise<SetupChecklist> {
  return convex().query(api.settings.getSetupChecklist, {});
}

/** Step 11: sets setupCompletedAt + audit entry; refused while blocking items exist (SET-004). */
export async function completeSetup(): Promise<void> {
  await convex().mutation(api.settings.completeSetup, {});
}
