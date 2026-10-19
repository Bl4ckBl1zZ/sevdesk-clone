import {
  ATTACHMENT_MAX_FILES,
  attachmentIssue,
  attachmentMime,
  type EvidenceKind,
  embedIssue,
  missingProof,
} from "../../src/domain/documents/attachments";
import type { DocumentSnapshot } from "../../src/domain/documents/snapshot";
import type { Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedPatch } from "./audit";
import { fileRefFromStorage } from "./bankImport";
import { getDocument, type SalesDocumentDoc } from "./salesDocuments";
import type { ModelCtx } from "./types";

/**
 * F04 DOC-18 attachments (drafts only; frozen at finalisation; `includeInExport` → export bundle, `embedInXml` →
 * BG-24) and INV-30 proofs („Nachweise“, appended after finalisation, never part of the snapshot).
 */

type Attachment = NonNullable<SalesDocumentDoc["attachments"]>[number];

function requireDraft(doc: SalesDocumentDoc) {
  if (doc.status !== "draft") {
    throw appError(
      "immutable_record",
      "Anhänge sind mit dem Fertigstellen eingefroren. Nachweise können unter „Nachweise“ ergänzt werden.",
      { reason: "ATTACHMENTS_FROZEN" },
    );
  }
}

const label = (doc: SalesDocumentDoc) => doc.number ?? "Entwurf";

export async function addAttachment(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  a: { storageId: Id<"_storage">; name: string; embedInXml?: boolean; includeInExport?: boolean },
): Promise<void> {
  const doc = await getDocument(ctx, id);
  requireDraft(doc);
  const file = await fileRefFromStorage(ctx, a.storageId, a.name);
  const list = doc.attachments ?? [];
  const issue = attachmentIssue(list.length, file);
  if (issue) throw appError("invalid_input", issue, { reason: "ATTACHMENT_INVALID" });
  if (list.some((x) => x.file.sha256 === file.sha256)) {
    throw appError("invalid_input", "Diese Datei ist bereits angehängt.", { reason: "ATTACHMENT_DUPLICATE" });
  }
  const mime = attachmentMime(file.name, file.mime) ?? file.mime;
  const embed = a.embedInXml === true ? embedIssue(mime) : null;
  if (embed) throw appError("invalid_input", embed, { reason: "ATTACHMENT_NOT_EMBEDDABLE" });
  const next: Attachment[] = [
    ...list,
    { file: { ...file, mime }, embedInXml: a.embedInXml === true, includeInExport: a.includeInExport !== false },
  ];
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    { attachments: next.slice(0, ATTACHMENT_MAX_FILES) },
    {
      action: "document.attachment_add",
      label: label(doc),
      reason: file.name,
    },
  );
}

export async function updateAttachment(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  sha256: string,
  flags: { embedInXml?: boolean; includeInExport?: boolean; remove?: boolean },
): Promise<void> {
  const doc = await getDocument(ctx, id);
  requireDraft(doc);
  const list = doc.attachments ?? [];
  const hit = list.find((x) => x.file.sha256 === sha256);
  if (!hit) throw appError("not_found", "Dieser Anhang existiert nicht.");
  const embed = flags.embedInXml === true ? embedIssue(hit.file.mime) : null;
  if (embed) throw appError("invalid_input", embed, { reason: "ATTACHMENT_NOT_EMBEDDABLE" });
  const next = flags.remove
    ? list.filter((x) => x !== hit)
    : list.map((x) =>
        x === hit
          ? {
              ...x,
              ...(flags.embedInXml !== undefined ? { embedInXml: flags.embedInXml } : {}),
              ...(flags.includeInExport !== undefined ? { includeInExport: flags.includeInExport } : {}),
            }
          : x,
      );
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    { attachments: next },
    {
      action: flags.remove ? "document.attachment_remove" : "document.attachment_update",
      label: label(doc),
      reason: hit.file.name,
    },
  );
}

/** INV-30: a proof appended to a finalised document (append-only, not part of the snapshot). */
export async function addEvidence(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  e: { storageId: Id<"_storage">; name: string; kind: EvidenceKind; note?: string },
): Promise<void> {
  const doc = await getDocument(ctx, id);
  if (doc.status === "draft") {
    throw appError("invalid_input", "Nachweise werden nach dem Fertigstellen ergänzt; vorher bitte als Anhang.", {
      reason: "EVIDENCE_DRAFT",
    });
  }
  const file = await fileRefFromStorage(ctx, e.storageId, e.name);
  const issue = attachmentIssue(0, file);
  if (issue) throw appError("invalid_input", issue, { reason: "ATTACHMENT_INVALID" });
  const note = e.note?.trim().slice(0, 500);
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    {
      evidence: [
        ...(doc.evidence ?? []),
        { file, kind: e.kind, ...(note ? { note } : {}), addedAt: ctx.now(), actor: ctx.actor },
      ],
    },
    { action: "document.evidence_add", label: label(doc), reason: file.name },
  );
}

/** Snapshot field of the frozen attachments (DOC-18; content is not part of the snapshot). */
export function frozenAttachments(doc: SalesDocumentDoc): Pick<DocumentSnapshot, "attachments"> {
  const list = doc.attachments ?? [];
  return list.length
    ? {
        attachments: list.map((a) => ({
          name: a.file.name,
          mime: a.file.mime,
          sha256: a.file.sha256,
          embedInXml: a.embedInXml,
        })),
      }
    : {};
}

/** Detail view of attachments and proofs incl. the INV-30 warning. */
export function attachmentsView(doc: SalesDocumentDoc) {
  return {
    attachments: (doc.attachments ?? []).map((a) => ({
      name: a.file.name,
      mime: a.file.mime,
      bytes: a.file.bytes,
      sha256: a.file.sha256,
      embedInXml: a.embedInXml,
      includeInExport: a.includeInExport,
    })),
    evidence: (doc.evidence ?? []).map((e) => ({
      name: e.file.name,
      sha256: e.file.sha256,
      kind: e.kind,
      note: e.note ?? null,
      addedAt: e.addedAt,
    })),
    proofWarning: doc.status === "draft" || doc.status === "cancelled" ? null : missingProof(doc, doc.evidence ?? []),
  };
}
