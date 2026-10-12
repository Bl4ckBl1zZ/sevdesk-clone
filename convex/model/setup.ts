import { validateCompanyForDocuments } from "../../src/domain/company/validate";
import { companyForValidation, type ProfileData } from "../../src/domain/settings/profile";
import { completedSteps, type SetupFacts, type SetupStep } from "../../src/domain/settings/progress";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { components } from "../_generated/api";
import { listBankAccounts } from "./bankAccounts";
import { getCompanyProfile } from "./companyProfile";
import { getIntegration } from "./integrations";
import { countLayouts } from "./layouts";
import { listDefaultRanges } from "./numberRanges";
import type { ReadCtx } from "./types";

/** Facts behind the derived wizard progress (F01 SET-003) — read-only. */
export async function setupFacts(ctx: ReadCtx): Promise<SetupFacts & { ownerEmail: string | null }> {
  const owner = await ctx.db
    .query("members")
    .withIndex("by_role", (q) => q.eq("role", "owner"))
    .first();
  let ownerPasskeys = 0;
  if (owner) {
    const res = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "passkey",
      where: [{ field: "userId", value: owner.authUserId }],
      paginationOpts: { numItems: 20, cursor: null },
    })) as { page: unknown[] };
    ownerPasskeys = res.page.length;
  }
  const profile = await getCompanyProfile(ctx);
  const mail = await getIntegration(ctx, "cloudflare_email");
  const storage = await getIntegration(ctx, "r2_checkpoint");
  return {
    ownerEmail: owner?.email ?? null,
    ownerPasskeys,
    accessConfirmed: Boolean(
      profile && profile.accessConcept.confirmedAt > 0 && profile.serverLocation.confirmedAt > 0,
    ),
    authMailDelivered: mail?.lastTestOk === true,
    checkpointStorageOk: storage?.lastTestOk === true,
    profile: profile as unknown as ProfileData | null,
    bankAccounts: (await listBankAccounts(ctx)).length,
    layouts: await countLayouts(ctx),
    numberRanges: (await listDefaultRanges(ctx)).length,
    ...(profile?.setupCompletedAt !== undefined ? { setupCompletedAt: profile.setupCompletedAt } : {}),
  };
}

export interface ChecklistItem {
  code: string;
  message: string;
  href: string;
}

const STEP_HREF = (slug: string) => `/einrichtung?schritt=${slug}`;

const FIELD_STEP: Record<string, string> = {
  taxNumber: "steuern",
  vatId: "steuern",
};

/** Steps that must be complete before the setup can be finished (SET-002: all except Bank and Layout). */
const REQUIRED_STEPS: { step: SetupStep; slug: string; message: string }[] = [
  { step: "inhaberkonto", slug: "inhaberkonto", message: "Für das Inhaberkonto ist noch kein Passkey eingerichtet." },
  { step: "zugriff", slug: "zugriff", message: "Serverstandort und Zugriffskonzept sind noch nicht bestätigt." },
  {
    step: "email",
    slug: "e-mail",
    message: "Es wurde noch keine Anmelde-E-Mail erfolgreich zugestellt — bitte „Test-Code senden“.",
  },
  {
    step: "speicher",
    slug: "speicher",
    message: "Der Prüfpunkt-Speicher (R2) wurde noch nicht erfolgreich getestet.",
  },
  { step: "unternehmen", slug: "unternehmen", message: "Die Unternehmensangaben sind unvollständig." },
  { step: "steuern", slug: "steuern", message: "Die Steuerangaben sind unvollständig." },
  { step: "nummernkreise", slug: "nummernkreise", message: "Die Nummernkreise wurden noch nicht gespeichert." },
];

/** Checklist of wizard step 11 (SET-004): the domain validator plus the required setup steps. */
export async function setupChecklist(
  ctx: ReadCtx,
  now: number,
): Promise<{ blocking: ChecklistItem[]; warnings: ChecklistItem[]; completed: SetupStep[] }> {
  const facts = await setupFacts(ctx);
  const completed = completedSteps(facts, berlinCalendarDate(now));
  const blocking: ChecklistItem[] = [];
  const warnings: ChecklistItem[] = [];
  for (const r of REQUIRED_STEPS) {
    if (!completed.includes(r.step))
      blocking.push({ code: `step_${r.step}`, message: r.message, href: STEP_HREF(r.slug) });
  }
  if (facts.profile) {
    const v = validateCompanyForDocuments(companyForValidation(facts.profile as ProfileData));
    const href = (field: unknown) => STEP_HREF(FIELD_STEP[String(field)] ?? "unternehmen");
    for (const i of v.blocking) {
      if (blocking.some((b) => b.code === i.code)) continue;
      blocking.push({ code: i.code, message: i.message, href: href(i.params?.field) });
    }
    for (const i of v.warnings) warnings.push({ code: i.code, message: i.message, href: href(i.params?.field) });
  }
  if (facts.bankAccounts === 0) {
    warnings.push({
      code: "no_bank_account",
      message: "Keine Bankverbindung — Rechnungen enthalten keine Zahlungsinformationen und keinen GiroCode.",
      href: STEP_HREF("bank"),
    });
  }
  return { blocking, warnings, completed };
}
