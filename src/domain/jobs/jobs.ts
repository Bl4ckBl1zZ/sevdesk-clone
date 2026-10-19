/**
 * Background job rules (F09 EXP-026, F04 SND-20, 03 §10 `jobs`). Pure.
 */

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** Allowed status transitions; `cancelled` only while queued or running (EXP-026 „abbrechbar, solange er läuft"). */
const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["running", "cancelled", "failed"],
  running: ["running", "done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export const canTransition = (from: JobStatus, to: JobStatus): boolean => TRANSITIONS[from].includes(to);

export const isActive = (s: JobStatus): boolean => s === "queued" || s === "running";

/** EXP-026: results are kept in file storage for 30 days. */
export const JOB_RESULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** SND-20: at most 2,000 documents per bulk job. */
export const BULK_MAX_DOCUMENTS = 2000;

export const JOB_STATUS_LABEL_DE: Readonly<Record<JobStatus, string>> = {
  queued: "Wartet",
  running: "Läuft",
  done: "Fertig",
  failed: "Fehlgeschlagen",
  cancelled: "Abgebrochen",
};

export const JOB_CANCELLED_MESSAGE = "Der Auftrag wurde abgebrochen.";
export const JOB_NOT_CANCELLABLE = "Der Auftrag ist bereits abgeschlossen und kann nicht mehr abgebrochen werden.";
export const JOB_EXPIRED =
  "Das Ergebnis ist nicht mehr verfügbar (Aufbewahrung 30 Tage). Bitte den Export erneut starten.";

/** Percentage for the progress bar (0–100, integer). */
export const progressPercent = (p: { done: number; total: number }): number =>
  p.total <= 0 ? 0 : Math.min(100, Math.floor((p.done * 100) / p.total));
