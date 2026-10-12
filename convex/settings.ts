import { v } from "convex/values";
import type { z } from "zod";
import { isEuEeaCountry } from "../src/domain/rules/eu-eea";
import {
  accessSchema,
  bankSchema,
  companySchema,
  emailStepSchema,
  LOGO_INVALID_MESSAGE,
  layoutSchema,
  numberRangeCreateSchema,
  numberRangesSchema,
  taxSchema,
  validateLogoFile,
} from "../src/domain/schemas/settings";
import {
  companyFormFromProfile,
  companyPatchFromForm,
  type ProfileData,
  taxFormFromProfile,
  taxPatchFromForm,
} from "../src/domain/settings/profile";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { action, actorMutation, mutation, query } from "./functions";
import { configuredTransport } from "./lib/authMail";
import { checkpointStoreFromEnv, r2LatestObject } from "./lib/checkpointStore";
import { baseDomain, env, passkeyRpId } from "./lib/env";
import { appError } from "./lib/errors";
import { defaultInvoiceAccount, saveDefaultInvoiceAccount } from "./model/bankAccounts";
import { getCompanyProfile, patchCompanyProfile } from "./model/companyProfile";
import { getIntegration, recordIntegrationTest } from "./model/integrations";
import { defaultLayout, saveDefaultLayout } from "./model/layouts";
import { getNotificationSettings, saveNotificationAddress } from "./model/notificationSettings";
import {
  createRange,
  deactivateRange,
  deleteRange,
  issuedCount,
  listDefaultRanges,
  listRanges,
  nextValue,
  saveRanges,
} from "./model/numberRanges";
import { setupChecklist, setupFacts } from "./model/setup";

/**
 * Setup wizard and company settings (F01 §3.1–3.7, SET-140…143). Public functions via the wrappers: every write
 * is owner-only (SET-142 owner-only sections use `settings.ownerOnly`, never grantable to API keys), audited
 * (`settings.<section>.update`) and re-validated with the shared zod schemas of src/domain/schemas/settings.
 */

type CheckStatus = "ok" | "warning" | "error" | "unknown";
interface StatusCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

/** Parses with the shared schema; zod issues → `invalid_input` with the first German message + all issues. */
function parse<S extends z.ZodType>(schema: S, values: unknown): z.output<S> {
  const r = schema.safeParse(values);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
  throw appError("invalid_input", issues[0]?.message, { issues });
}

const yearMonth = (now: number) => {
  const d = berlinCalendarDate(now);
  return { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)) };
};

const integrationCheck = (row: Doc<"integrations"> | null, id: string, label: string): StatusCheck | undefined =>
  row?.lastTestAt === undefined
    ? undefined
    : {
        id,
        label,
        status: row.lastTestOk ? "ok" : "error",
        ...(row.lastTestDetail ? { detail: row.lastTestDetail } : {}),
      };

// ── reads ─────────────────────────────────────────────────────────────────────────────────────────────
/** Wizard progress and the stored values of every step (SET-003, SET-007, SET-009a, SET-009b). */
export const getSetupState = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) => {
    const now = ctx.now();
    const today = berlinCalendarDate(now);
    const facts = await setupFacts(ctx);
    const { completed } = await setupChecklist(ctx, now);
    const profile = (await getCompanyProfile(ctx)) as (Doc<"companyProfile"> & ProfileData) | null;
    const domain = baseDomain() ?? "";
    const mail = await getIntegration(ctx, "cloudflare_email");
    const storage = await getIntegration(ctx, "r2_checkpoint");
    const notifications = await getNotificationSettings(ctx);
    const bank = await defaultInvoiceAccount(ctx);
    const layout = await defaultLayout(ctx);
    const ranges = await listDefaultRanges(ctx);
    const ym = yearMonth(now);
    const transport = configuredTransport();
    const storageCheck = integrationCheck(storage, "checkpoint", "Prüfpunkt-Bucket (R2)");
    return {
      version: profile?.version ?? 0,
      completedSteps: completed,
      ownerEmail: facts.ownerEmail ?? env("OWNER_EMAIL") ?? "",
      access: {
        baseDomain: domain,
        hosts: domain ? ["app", "api", "convex", "convex-site", "convex-dash"].map((h) => `${h}.${domain}`) : [],
        checks: [] as StatusCheck[],
        ...(profile && profile.accessConcept.confirmedAt > 0
          ? {
              values: {
                countryCode: profile.serverLocation.countryCode,
                provider: profile.serverLocation.provider ?? "",
                nonEuConfirmed: !isEuEeaCountry(profile.serverLocation.countryCode),
                tailnetName: profile.accessConcept.tailnetName ?? "",
                tailnetOnlyConfirmed: true,
              },
            }
          : {}),
      },
      email: {
        sender: transport === "cloudflare" ? (env("AUTH_MAIL_FROM") ?? "") : `${transport} (Entwicklung/Test)`,
        accountId: env("CLOUDFLARE_ACCOUNT_ID") ?? "",
        tokenConfigured: transport !== "cloudflare" || env("CLOUDFLARE_EMAIL_API_TOKEN") !== undefined,
        ...(mail?.lastTestAt !== undefined
          ? { lastDelivery: integrationCheck(mail, "delivery", "Letzte Zustellung") as StatusCheck }
          : {}),
        notificationEmail: notifications?.email?.address ?? facts.ownerEmail ?? "",
      },
      storage: { checks: storageCheck ? [storageCheck] : [] },
      ...(profile ? { company: companyFormFromProfile(profile) } : {}),
      ...(profile ? { tax: taxFormFromProfile(profile, today) } : {}),
      ...(bank
        ? {
            bank: {
              iban: bank.iban ?? "",
              bic: bank.bic ?? "",
              accountHolder: bank.accountHolder,
              currency: "EUR" as const,
            },
          }
        : {}),
      ...(layout?.version
        ? { layout: { template: layout.version.config.template, accentColor: layout.version.config.accentColor } }
        : {}),
      ...(ranges.length > 0
        ? {
            numberRanges: await Promise.all(
              ranges.map(async (r) => ({
                key: r.docTypes[0] ?? "",
                name: r.name,
                format: r.format,
                resetPolicy: r.resetPolicy,
                next: await nextValue(ctx, r, ym),
              })),
            ),
          }
        : {}),
      ...(profile?.logoStorageId ? { logoUrl: await ctx.storage.getUrl(profile.logoStorageId) } : {}),
      ...(profile?.setupCompletedAt !== undefined ? { setupCompletedAt: profile.setupCompletedAt } : {}),
    };
  },
});

/** Step 11 checklist (SET-004) from `validateCompanyForDocuments` plus the required steps. */
export const getSetupChecklist = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) => {
    const { blocking, warnings } = await setupChecklist(ctx, ctx.now());
    return { blocking, warnings };
  },
});

/** SET-001: whether the setup is complete (any signed-in member; drives the redirect to /einrichtung). */
export const setupStatus = query({
  permission: "session.self",
  args: {},
  handler: async (ctx) => {
    const profile = await getCompanyProfile(ctx);
    return { setupCompleted: profile?.setupCompletedAt !== undefined };
  },
});

// ── writes ────────────────────────────────────────────────────────────────────────────────────────────
/** Step 2: server location (AO-06, SET-046) and access concept (SET-007/047) — owner only, never via API. */
export const saveAccessConcept = mutation({
  permission: "settings.ownerOnly",
  args: { values: v.any() },
  handler: async (ctx, { values }) => {
    const a = parse(accessSchema, values);
    const now = ctx.now();
    const nonEu = !isEuEeaCountry(a.countryCode);
    await patchCompanyProfile(
      ctx,
      {
        serverLocation: { countryCode: a.countryCode, provider: a.provider, confirmedAt: now },
        accessConcept: {
          baseDomain: baseDomain() ?? "",
          network: "tailnet",
          ...(a.tailnetName ? { tailnetName: a.tailnetName } : {}),
          confirmedAt: now,
        },
      },
      {
        action: "settings.access.update",
        ...(nonEu
          ? { reason: "Genehmigung des Finanzamts zur Buchführung außerhalb der EU liegt vor (§ 146 Abs. 2b AO)" }
          : {}),
      },
    );
  },
});

/** Step 3: owner notification address (default OWNER_EMAIL). */
export const saveNotificationEmail = mutation({
  permission: "settings.write",
  args: { values: v.any() },
  handler: async (ctx, { values }) => {
    const e = parse(emailStepSchema, values);
    await saveNotificationAddress(ctx, e.notificationEmail);
  },
});

/** Step 6 / Einstellungen › Unternehmen (SET-010, SET-015…017). New companyProfile version. */
export const saveCompanyProfile = mutation({
  permission: "settings.write",
  args: { values: v.any(), expectedVersion: v.optional(v.number()) },
  handler: async (ctx, { values, expectedVersion }) => {
    const c = parse(companySchema, values);
    const current = await getCompanyProfile(ctx);
    return patchCompanyProfile(ctx, companyPatchFromForm(c, current ?? undefined), {
      action: "settings.company.update",
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
  },
});

/** Step 7 / Einstellungen › Steuern (SET-030…044) — tax status is owner-only (SET-142). */
export const saveTaxSettings = mutation({
  permission: "settings.ownerOnly",
  args: { values: v.any(), expectedVersion: v.optional(v.number()) },
  handler: async (ctx, { values, expectedVersion }) => {
    const current = (await getCompanyProfile(ctx)) as (Doc<"companyProfile"> & ProfileData) | null;
    // The legal form always comes from the stored company data (EÜR/fiscal-year rules, SET-039/042).
    const t = parse(taxSchema, { ...(values as object), legalForm: current?.legalForm ?? "einzelunternehmen" });
    const empty = {
      kleinunternehmer: [],
      taxationMethod: [],
      ustvaPeriod: [],
      profitMethod: [],
      chartOfAccounts: [],
      fiscalYearStartMonth: 1,
      priorYearTotalTurnoverCents: [],
    };
    const now = ctx.now();
    const res = taxPatchFromForm(t, current ?? empty, { today: berlinCalendarDate(now), now });
    if (!res.ok) throw appError("invalid_input", res.error.message, { reason: res.error.code });
    return patchCompanyProfile(ctx, res.patch as never, {
      action: "settings.tax.update",
      ...(t.taxationMethod === "ist"
        ? { reason: "Genehmigung des Finanzamts für die Ist-Versteuerung liegt vor" }
        : {}),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
  },
});

/** Step 8 / Einstellungen › Bank: the default EUR invoice account (SET-050…053). */
export const saveBankAccount = mutation({
  permission: "settings.write",
  args: { values: v.any() },
  handler: async (ctx, { values }) => {
    const b = parse(bankSchema, values);
    const profile = await getCompanyProfile(ctx);
    const chart = profile?.chartOfAccounts.at(-1)?.chart ?? "SKR03";
    await saveDefaultInvoiceAccount(ctx, b, chart);
  },
});

/** Step 9: upload URL for the logo (Convex file storage, SET-018). Writes nothing. */
export const generateLogoUploadUrl = mutation({
  permission: "settings.write",
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

/** Step 9 / Einstellungen › Layouts: default layout as a new version (SET-070/071) and the logo (SET-018/023). */
export const saveLayout = mutation({
  permission: "settings.write",
  args: { values: v.any(), logoStorageId: v.optional(v.id("_storage")) },
  handler: async (ctx, { values, logoStorageId }) => {
    const l = parse(layoutSchema, values);
    if (logoStorageId) {
      const meta = await ctx.db.system.get(logoStorageId);
      if (!meta || validateLogoFile({ type: meta.contentType ?? "", size: meta.size }) !== null) {
        throw appError("invalid_input", LOGO_INVALID_MESSAGE, { reason: "LOGO_INVALID" });
      }
      // SET-023: the previous logo file is kept (finalised documents may reference it).
      await patchCompanyProfile(ctx, { logoStorageId }, { action: "settings.logo.update" });
    }
    await saveDefaultLayout(ctx, l);
  },
});

/** Step 10 / Einstellungen › Nummernkreise: formats and next values (SET-006, SET-055…059). */
export const saveNumberRanges = mutation({
  permission: "settings.write",
  args: { values: v.any() },
  handler: async (ctx, { values }) => {
    const r = parse(numberRangesSchema, values);
    await saveRanges(ctx, r, yearMonth(ctx.now()));
  },
});

/** Einstellungen › Nummernkreise: every range with its next value and whether numbers were issued (SET-055/062). */
export const listNumberRanges = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) => {
    const ym = yearMonth(ctx.now());
    return Promise.all(
      (await listRanges(ctx)).map(async (r) => ({
        rangeId: r._id,
        name: r.name,
        docTypes: r.docTypes,
        format: r.format,
        resetPolicy: r.resetPolicy,
        active: r.active,
        isDefault: r.isDefault,
        next: await nextValue(ctx, r, ym),
        inUse: (await issuedCount(ctx, r._id)) > 0,
      })),
    );
  },
});

/** SET-055: an additional range (collision-checked, SET-060). */
export const createNumberRange = mutation({
  permission: "settings.write",
  args: { values: v.any() },
  handler: async (ctx, { values }) => createRange(ctx, parse(numberRangeCreateSchema, values), yearMonth(ctx.now())),
});

/** SET-062: deactivate a range (never the only active default of a type). */
export const deactivateNumberRange = mutation({
  permission: "settings.write",
  args: { rangeId: v.id("numberRanges") },
  handler: async (ctx, { rangeId }) => deactivateRange(ctx, rangeId),
});

/** SET-062: delete an unused range (`RANGE_IN_USE` once numbers were issued). */
export const deleteNumberRange = mutation({
  permission: "settings.write",
  args: { rangeId: v.id("numberRanges") },
  handler: async (ctx, { rangeId }) => deleteRange(ctx, rangeId),
});

/** Step 11: sets `setupCompletedAt` + audit entry; refused while blocking items exist (SET-004). */
export const completeSetup = mutation({
  permission: "settings.ownerOnly",
  args: {},
  handler: async (ctx) => {
    const { blocking } = await setupChecklist(ctx, ctx.now());
    if (blocking.length > 0) {
      throw appError("setup_incomplete", blocking[0]?.message, { codes: blocking.map((b) => b.code) });
    }
    const profile = await getCompanyProfile(ctx);
    if (profile?.setupCompletedAt !== undefined) return profile.setupCompletedAt;
    const at = ctx.now();
    await patchCompanyProfile(ctx, { setupCompletedAt: at }, { action: "settings.setup.complete" });
    return at;
  },
});

// ── live checks (actions) ─────────────────────────────────────────────────────────────────────────────
async function probe(url: string, init: RequestInit = {}): Promise<{ status: number } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    return { status: res.status };
  } catch (e) {
    return { error: String(e instanceof Error ? e.message : e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** Step 2 live checks (SET-007): hosts reachable with a valid certificate, `api.` 404, dashboard basic auth, RP ID. */
export const runAccessChecks = action({
  permission: "integrations.manage",
  args: {},
  handler: async (): Promise<StatusCheck[]> => {
    const domain = baseDomain();
    if (!domain) {
      return [{ id: "domain", label: "BASE_DOMAIN", status: "error", detail: "BASE_DOMAIN ist nicht gesetzt." }];
    }
    const checks: StatusCheck[] = [];
    const reach = async (host: string, path: string) => {
      const r = await probe(`https://${host}.${domain}${path}`);
      checks.push(
        "error" in r
          ? {
              id: host,
              label: `${host}.${domain}`,
              status: "error",
              detail: `Nicht erreichbar oder Zertifikat ungültig: ${r.error}`,
            }
          : { id: host, label: `${host}.${domain}`, status: "ok", detail: `HTTPS ${r.status}` },
      );
      return r;
    };
    await reach("app", "/api/health");
    const api = await reach("api", "/einstellungen");
    if (!("error" in api) && api.status !== 404) {
      checks.push({
        id: "api-ui",
        label: `api.${domain} liefert keine Seiten der Oberfläche`,
        status: "error",
        detail: `Erwartet 404, erhalten ${api.status}.`,
      });
    }
    await reach("convex", "/version");
    await reach("convex-site", "/api/auth/ok");
    const dash = await reach("convex-dash", "/");
    if (!("error" in dash) && dash.status !== 401) {
      checks.push({
        id: "dash-auth",
        label: `convex-dash.${domain} verlangt Basic Auth`,
        status: "error",
        detail: `Erwartet 401, erhalten ${dash.status}.`,
      });
    }
    checks.push({ id: "session", label: "Anfrage mit gültiger Sitzung", status: "ok" });
    const rp = passkeyRpId();
    checks.push(
      rp === domain
        ? { id: "rp", label: "Passkey-RP-ID = BASE_DOMAIN", status: "ok", detail: rp }
        : { id: "rp", label: "Passkey-RP-ID = BASE_DOMAIN", status: "error", detail: `${rp ?? "—"} ≠ ${domain}` },
    );
    return checks;
  },
});

export const recordStorageTest = actorMutation({
  permission: "integrations.manage",
  args: { ok: v.boolean(), detail: v.string() },
  handler: async (ctx, { ok, detail }) => recordIntegrationTest(ctx, "r2_checkpoint", { ok, detail }),
});

/** Step 4 / Integrationen: R2 checkpoint probe write/read/delete, bucket lock, latest backup (SET-009b, SET-115). */
export const testCheckpointStorage = action({
  permission: "integrations.manage",
  args: {},
  handler: async (ctx): Promise<StatusCheck[]> => {
    const store = checkpointStoreFromEnv();
    const checks: StatusCheck[] = [];
    let ok = false;
    let detail: string;
    if (!store) {
      detail = "Der R2-Prüfpunkt-Bucket ist nicht eingerichtet (R2_CHECKPOINT_* fehlt).";
    } else {
      const key = `probe/${ctx.now()}.txt`;
      const body = `probe ${ctx.now()}`;
      const put = await store.put(key, body);
      const got = put.ok ? await store.get(key).catch((e: unknown) => `ERR ${String(e)}`) : null;
      const del = put.ok ? await store.delete(key) : { ok: false as const, detail: "" };
      ok = put.ok && got === body && del.ok;
      detail = ok
        ? `Schreiben, Lesen und Löschen erfolgreich (${store.location(key).replace(/\/probe\/.*$/, "")}).`
        : !put.ok
          ? `Schreiben fehlgeschlagen: ${put.detail}`
          : got !== body
            ? "Lesen fehlgeschlagen: Inhalt weicht ab."
            : `Löschen fehlgeschlagen: ${"detail" in del ? del.detail : ""}`;
    }
    checks.push({ id: "checkpoint", label: "Prüfpunkt-Bucket (R2)", status: ok ? "ok" : "error", detail });
    const lock = store ? await store.bucketLock() : "unknown";
    checks.push({
      id: "bucketLock",
      label: "Aufbewahrungssperre (Bucket Lock)",
      status: lock === "present" ? "ok" : "warning",
      detail:
        lock === "present"
          ? "Aufbewahrungsregel vorhanden."
          : "Für den Prüfpunkt-Bucket ist keine Aufbewahrungssperre (Bucket Lock) eingerichtet. Empfohlen, damit Prüfpunkte nicht gelöscht werden können (SEC-04).",
    });
    const endpoint = env("R2_ACCOUNT_ENDPOINT");
    const bucket = env("R2_BACKUP_BUCKET");
    const keyId = env("R2_BACKUP_READONLY_ACCESS_KEY_ID");
    const secret = env("R2_BACKUP_READONLY_SECRET_ACCESS_KEY");
    if (endpoint && bucket && keyId && secret) {
      const latest = await r2LatestObject({
        endpoint,
        bucket,
        accessKeyId: keyId,
        secretAccessKey: secret,
        prefix: "postgres/",
      });
      checks.push(
        latest.ok && latest.latest
          ? {
              id: "backups",
              label: "Datensicherungen",
              status: "ok",
              detail: `Letzte Sicherung: ${latest.latest.lastModified}`,
            }
          : {
              id: "backups",
              label: "Datensicherungen",
              status: "warning",
              detail: latest.ok
                ? "Noch keine Sicherung im Backup-Bucket."
                : `Backup-Bucket nicht lesbar: ${latest.detail}`,
            },
      );
    } else {
      checks.push({
        id: "backups",
        label: "Datensicherungen",
        status: "warning",
        detail: "Noch keine Sicherung gefunden (Backup-Bucket nicht eingerichtet).",
      });
    }
    await ctx.runMutation(internal.settings.recordStorageTest, { actorContext: ctx.actorContext, ok, detail });
    return checks;
  },
});
