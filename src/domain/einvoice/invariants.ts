/**
 * E-invoice invariants (10-edge-cases §2), pure; convex/model/invariants.ts feeds them the finalised documents.
 *
 * - RI-18 (ER-03, ER-12, MAIL-04): a document whose ER-03 decision was `MUST_E` has an archived, validated
 *   E-Rechnung XML — or `artifactStatus = "blocked"` with the sent mark disabled. While the artifacts are still
 *   `pending` (EC-005 retry) nothing is archived yet. If marked sent, the effective (first non-retracted) mark handed
 *   over the structured e-invoice on an electronic channel. The KoSIT report is required unless the preview
 *   validation was `skipped` (test deployments without the sidecar, convex/lib/einvoiceTools.ts).
 * - RI-25 (ER-20): every invoice to a public authority (B2G) carries a valid Leitweg-ID in BT-10.
 */
import type { DocumentSnapshot, Er03Decision, SalesDocType } from "../documents/snapshot";
import { isInvoiceType } from "../documents/snapshot";
import { validateLeitwegId } from "./leitweg-id";

export interface EinvoiceInvariantFinding {
  readonly id: "RI-18" | "RI-25";
  readonly severity: "ERROR";
  readonly message: string;
}

export interface EinvoiceInvariantDoc {
  readonly name: string;
  readonly type: SalesDocType;
  readonly status: string;
  readonly imported?: boolean | undefined;
  readonly decision?: Er03Decision | undefined;
  readonly validation?: "passed" | "skipped" | "not_required" | undefined;
  readonly artifactStatus?: "pending" | "ready" | "blocked" | undefined;
  readonly snapshot: Pick<DocumentSnapshot, "einvoice" | "buyer" | "references">;
  /** Archived artifacts of the document. */
  readonly artifacts: readonly { readonly id: string; readonly kind: string }[];
  /** Send log of the document in recording order. */
  readonly marks: readonly {
    readonly id: string;
    readonly kind: "mark_sent" | "retraction";
    readonly retractsId?: string | undefined;
    readonly channel: string;
    readonly artifactIds: readonly string[];
    readonly einvoiceHandedOverElectronically?: boolean | undefined;
  }[];
}

const STRUCTURED = new Set(["xrechnung_xml", "zugferd_pdf"]);
const ELECTRONIC = new Set(["email_manual", "upload_portal", "other"]);

export function checkEinvoiceDocument(d: EinvoiceInvariantDoc): EinvoiceInvariantFinding[] {
  if (d.imported || d.status === "draft") return [];
  const out: EinvoiceInvariantFinding[] = [];
  const err = (id: EinvoiceInvariantFinding["id"], message: string) => out.push({ id, severity: "ERROR", message });

  if (d.decision === "MUST_E") {
    const kinds = new Set(d.artifacts.map((a) => a.kind));
    if (d.snapshot.einvoice.format === "none") err("RI-18", `${d.name}: E-Rechnung Pflicht, aber ohne XML-Format.`);
    if (d.validation === "not_required") err("RI-18", `${d.name}: E-Rechnung Pflicht, aber nicht validiert.`);
    if (d.artifactStatus === "ready") {
      if (!kinds.has("xrechnung_xml")) err("RI-18", `${d.name}: E-Rechnung Pflicht, aber keine XML archiviert.`);
      if (d.validation !== "skipped" && !kinds.has("validation_report_kosit")) {
        err("RI-18", `${d.name}: E-Rechnung Pflicht, aber kein Prüfbericht (KoSIT) archiviert.`);
      }
    }
    const retracted = new Set(d.marks.flatMap((m) => (m.kind === "retraction" && m.retractsId ? [m.retractsId] : [])));
    const effective = d.marks.find((m) => m.kind === "mark_sent" && !retracted.has(m.id));
    if (effective && d.artifactStatus === "blocked") {
      err("RI-18", `${d.name}: Dateien blockiert, trotzdem als versendet markiert.`);
    }
    if (effective) {
      const structured = effective.artifactIds.some((id) =>
        STRUCTURED.has(d.artifacts.find((a) => a.id === id)?.kind ?? ""),
      );
      if (!ELECTRONIC.has(effective.channel) || !structured || effective.einvoiceHandedOverElectronically !== true) {
        err("RI-18", `${d.name}: E-Rechnung Pflicht, aber nicht elektronisch als E-Rechnung übergeben.`);
      }
    }
  }

  if (isInvoiceType(d.type) && d.snapshot.buyer.isPublicAuthority) {
    const lw = validateLeitwegId(d.snapshot.references.buyerReference);
    if (!lw.ok) {
      err(
        "RI-25",
        `${d.name}: Rechnung an einen öffentlichen Auftraggeber ohne gültige Leitweg-ID (BT-10: ${d.snapshot.references.buyerReference ?? "–"}).`,
      );
    }
  }
  return out;
}
