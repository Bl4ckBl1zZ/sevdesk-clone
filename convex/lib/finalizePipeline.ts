import type { Value } from "convex/values";
import type { DocumentSnapshot } from "../../src/domain/documents/snapshot";
import { serializeEinvoice } from "../../src/domain/einvoice/serialize";
import { clockSkewBlocksFinalization } from "../../src/domain/system/clock";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { ActorContext } from "../model/types";
import { clockOffsetMs } from "./clock";
import { validateXml } from "./einvoiceTools";
import { appError } from "./errors";

export interface PipelineOptions {
  documentDate?: string;
  backdateReason?: string;
  overrides?: { vatCheck?: { reason: string }; rc13bCertificate?: { reason: string } };
}

interface PreviewOut {
  status: string;
  version: number;
  number: string | null;
  finalizedFromVersion: number | null;
  findings: { code: string; severity: string; message: string }[];
  snapshotJson: string | null;
  format: "zugferd_en16931" | "zugferd_xrechnung" | "xrechnung_cii" | "xrechnung_ubl" | "none";
  expected: { taxCase: string; buyerIsConsumer: boolean } | null;
}
type CommitOut =
  | { status: "finalized"; number: string; idempotentReplay: boolean }
  | { status: "invalid"; findings?: { message: string }[] };

/**
 * „Fertigstellen“ (F04 DOC-24, 02 §6): validation → preview snapshot → preview XML validation (KoSIT) → commit →
 * render. Errors before the commit consume no number (EC-007, T-DOC-018). One implementation for the UI/REST/MCP
 * action (`invoices.finalize`) and the recurring generator (`recurring.generate`, REC-07), which runs it as
 * `system:cron.recurring.generate`.
 */
export async function runFinalizePipeline(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  actorContext: ActorContext,
  a: { id: Id<"salesDocuments">; version: number; confirmToken?: string } & PipelineOptions,
): Promise<{ number: string; idempotentReplay: boolean }> {
  const opts: PipelineOptions = {
    ...(a.documentDate ? { documentDate: a.documentDate } : {}),
    ...(a.backdateReason ? { backdateReason: a.backdateReason } : {}),
    ...(a.overrides ? { overrides: a.overrides } : {}),
  };
  const p: PreviewOut = await ctx.runQuery(internal.invoices.pipelinePreview, { id: a.id, ...opts });
  if (p.status !== "draft") {
    if (p.finalizedFromVersion === a.version && p.number) return { number: p.number, idempotentReplay: true };
    throw appError("document_not_draft");
  }
  if (p.version !== a.version) {
    // EC-DOC-04: an MCP finalisation carries the token of a preview of the older version → that preview is outdated.
    if (a.confirmToken) throw appError("preview_outdated");
    throw appError("version_conflict", "Der Entwurf wurde zwischenzeitlich geändert. Bitte Vorschau aktualisieren.");
  }
  const errors = p.findings.filter((f) => f.severity === "E");
  if (errors.length > 0 || !p.snapshotJson) {
    throw appError("validation_failed", errors[0]?.message, { findings: errors as unknown as Value[] });
  }
  // DOC-59 / EC-027: no number is assigned while the server clock is off by more than 60 s.
  const skew = clockSkewBlocksFinalization(await clockOffsetMs());
  if (skew) throw appError("clock_skew", skew.message);
  let validation: "passed" | "skipped" | "not_required" = "not_required";
  if (p.format !== "none") {
    const snapshot = JSON.parse(p.snapshotJson) as DocumentSnapshot;
    const xml = serializeEinvoice(snapshot, p.format).xml;
    const outcome = await validateXml(xml);
    if (outcome.kind === "unavailable") throw appError("dependency_unavailable", undefined, { detail: outcome.detail });
    if (outcome.kind === "failed") {
      const first = outcome.errors[0];
      throw appError(
        "einvoice_validation_failed",
        `Die E-Rechnung ist ungültig (${outcome.errors.length} Fehler). Erster Fehler: ${first?.ruleId ?? "?"} – ${first?.text ?? ""}.`,
        { errors: outcome.errors.slice(0, 20) as unknown as Value[] },
      );
    }
    validation = outcome.kind === "passed" ? "passed" : "skipped";
  }
  const r: CommitOut = await ctx.runMutation(internal.invoices.commit, {
    actorContext,
    id: a.id,
    version: a.version,
    validation,
    ...(p.expected ? { expected: p.expected } : {}),
    ...opts,
    // ⚠ MCP (06 §3.4): the commit consumes the document_preview token in its transaction.
    ...(a.confirmToken ? { confirmToken: a.confirmToken } : {}),
  });
  if (r.status !== "finalized") {
    const first = (r.findings ?? [])[0];
    throw appError("revalidation_failed", first?.message, { findings: (r.findings ?? []) as unknown as Value[] });
  }
  return { number: r.number, idempotentReplay: r.idempotentReplay };
}
