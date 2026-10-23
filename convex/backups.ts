import { v } from "convex/values";
import {
  BACKUP_SOURCES,
  BACKUP_UNCHECKABLE,
  type BackupRow,
  type BackupStatus,
  BUCKET_LOCK_MISSING,
  evaluateBackup,
  type LatestObject,
  worstStatus,
} from "../src/domain/system/backups";
import { internal } from "./_generated/api";
import { action, systemAction, systemMutation } from "./functions";
import { backupListerFromEnv, checkpointListerFromEnv } from "./lib/backupStore";
import { checkpointStoreFromEnv } from "./lib/checkpointStore";
import { isTest } from "./lib/env";
import { berlinParts } from "./lib/time";
import { notifyKind, resolveEntityNotifications } from "./model/notifications";
import { emitEvent } from "./model/webhooks";

/**
 * Backup status (F12 AUD-026; 02 §7 `backups.verify`, daily 05:30): `/einstellungen/system/backups` reads it live;
 * the cron raises `backup.stale` for a warning/error and resolves it once every source is fresh again. Without the
 * read-only R2 credentials (`R2_BACKUP_READONLY_*`) the status is „nicht eingerichtet“ and nothing is notified.
 */

export interface BackupOverview {
  configured: boolean;
  bucket: string | null;
  sources: BackupRow[];
  checkpoint: { latest: LatestObject | null; bucketLock: "present" | "absent" | "unknown" } | null;
  status: BackupStatus;
  checkedAt: number;
  /** F12 E-AUD-44/45 warnings (missing read-only credentials, no bucket lock on the checkpoint bucket). */
  notices: string[];
}

async function computeOverview(now: number): Promise<BackupOverview> {
  const lister = backupListerFromEnv();
  if (!lister) {
    return {
      configured: false,
      bucket: null,
      sources: [],
      checkpoint: null,
      status: "unknown",
      checkedAt: now,
      notices: [BACKUP_UNCHECKABLE],
    };
  }
  const sources: BackupRow[] = [];
  for (const s of BACKUP_SOURCES) {
    try {
      sources.push(evaluateBackup(s, await lister.latest(s.prefix), now));
    } catch {
      sources.push({
        prefix: s.prefix,
        label: s.label,
        latest: null,
        ageHours: null,
        status: "unknown",
        detail: "Bucket konnte nicht gelesen werden (Zugangsdaten prüfen).",
      });
    }
  }
  const cpLister = checkpointListerFromEnv();
  let checkpoint: BackupOverview["checkpoint"] = null;
  if (cpLister) {
    const latest = await cpLister.latest("checkpoints/").catch(() => null);
    const bucketLock =
      (await checkpointStoreFromEnv()
        ?.bucketLock()
        .catch(() => "unknown" as const)) ?? "unknown";
    checkpoint = { latest, bucketLock };
  }
  return {
    configured: true,
    bucket: lister.bucket,
    sources,
    checkpoint,
    status: worstStatus(sources.map((r) => r.status)),
    checkedAt: now,
    notices: checkpoint?.bucketLock === "absent" ? [BUCKET_LOCK_MISSING] : [],
  };
}

/** AUD-026: live status for the page (members with settings.read). */
export const status = action({
  permission: "settings.read",
  args: {},
  handler: async (): Promise<BackupOverview> => computeOverview(Date.now()),
});

const ENTITY = { table: "system", id: "backups" } as const;

export const recordCheck = systemMutation({
  job: "cron.backups.verify",
  args: { status: v.string(), detail: v.string() },
  handler: async (ctx, { status, detail }) => {
    if (status === "warning" || status === "error") {
      await notifyKind(ctx, "backup.stale", { title: detail, link: "/einstellungen/system/backups", entity: ENTITY });
      // F12 §7 backup.stale (each daily check while stale; no bucket or file names)
      await emitEvent(ctx, "backup.stale", {
        id: "backup_status",
        object: "backup_status",
        status,
        updated_at: new Date(ctx.now()).toISOString(),
      });
      return "notified";
    }
    if (status === "ok") await resolveEntityNotifications(ctx, ENTITY, "backup.stale");
    return "ok";
  },
});

/** 02 §7 `backups.verify` (daily 05:30 Europe/Berlin via the hourly tick). */
export const verifyCron = systemAction({
  job: "cron.backups.verify",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }): Promise<string | null> => {
    if (isTest() && !force) return null;
    if (berlinParts(Date.now()).hour !== 5 && !force) return null;
    const o = await computeOverview(Date.now());
    if (!o.configured) return null;
    const stale = o.sources.filter((r) => r.status === "warning" || r.status === "error");
    const detail = stale.length
      ? stale.map((r) => `${r.label}: ${r.detail}`).join(" ")
      : "Alle Sicherungen sind aktuell.";
    return ctx.runMutation(internal.backups.recordCheck, { status: o.status, detail });
  },
});
