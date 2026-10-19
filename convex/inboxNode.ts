"use node";

import { v } from "convex/values";
import { sha256Hex } from "../src/domain/audit/chain";
import { checkAddressee } from "../src/domain/einvoice/addressee";
import { compareWithPdfText, pdfMismatchMessage } from "../src/domain/einvoice/compare-pdf";
import { invoiceSyntaxOf, parseReceivedXml, RECEIVE_MESSAGES } from "../src/domain/einvoice/parse";
import { notEInvoiceMessage } from "../src/domain/einvoice/profile";
import type { ReceivedInvoice } from "../src/domain/einvoice/received";
import { supplierEinvoiceObligation } from "../src/domain/einvoice/supplier-obligation";
import { germanRateFromRules, receivedToVoucherDraft } from "../src/domain/einvoice/to-voucher";
import { contentFindings, type Finding, faultyMessage, verdictOf } from "../src/domain/einvoice/verdict";
import { senderAllowed } from "../src/domain/inbox/allowlist";
import { INBOX_MAIL_MESSAGES, parseInboundEmail } from "../src/domain/inbox/email";
import { OCR_MESSAGES, OCR_REVIEW_THRESHOLD, postValidateExtraction } from "../src/domain/inbox/ocr";
import { budgetExceeded } from "../src/domain/inbox/ocr-settings";
import { planPoll } from "../src/domain/inbox/r2-plan";
import { INBOX_MESSAGES, nextRetryDelayMs } from "../src/domain/inbox/status";
import { pageCount } from "../src/domain/vouchers/capture";
import { renderEinvoiceVisualisation } from "../src/pdf/einvoice-visualisation";
import { ENCRYPTED_PDF_MESSAGE, extractInvoiceXml, multipleXmlMessage, pdfTextLayer } from "../src/pdf/hybrid";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, systemAction } from "./functions";
import { claudeOcrFor } from "./lib/claudeOcr";
import { inboundValidator } from "./lib/einvoiceInbound";
import { inboxBucketFromEnv } from "./lib/r2Inbox";
import { decryptSecret } from "./lib/secrets";
import type { ActorContext } from "./model/types";
import { vActorContext } from "./validators";

/**
 * Node actions of the receipt inbox (F06 §4.1): the classification pipeline and the R2 e-mail-in poll. They compute
 * and write file storage; every database write goes through the internal mutations in convex/inbox.ts with the
 * capturing actor (user upload → the user; e-mail-in → `system:cron.inbox.pollR2`).
 *
 *   classify   1 e-mail: unpack the .eml (INB-050)        3 hybrid PDF → embedded XML (INB-022, no OCR)
 *              2 XML UBL/CII → EN 16931 (INB-021/023)       4 PDF/image → Claude OCR if enabled (INB-025/026)
 *              → validation (INB-024) → mapping (INB-043)   5 otherwise manual (INB-027)
 *              → always a voucher draft (INB-028)
 *   pollR2     list ≤ 50 oldest inbox/*.eml, per object: known? → delete; GET → hash → store → ONE mutation →
 *              only then DELETE (INB-049, EC-INB-23/27); health + notifications (INB-052, EC-INB-28/29/32)
 */

type Item = Doc<"inboxItems">;
type Warning = { code: string; message: string; acknowledge?: boolean };

const textOf = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");

async function bytesOf(ctx: { storage: { get: (id: Id<"_storage">) => Promise<Blob | null> } }, id: Id<"_storage">) {
  const blob = await ctx.storage.get(id);
  if (!blob) throw new Error("Datei nicht gefunden");
  return new Uint8Array(await blob.arrayBuffer());
}

async function storeBytes(
  ctx: { storage: { store: (b: Blob) => Promise<Id<"_storage">> } },
  bytes: Uint8Array,
  mime: string,
) {
  return ctx.storage.store(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
}

/**
 * INB-040: the downloadable visualisation PDF („Visualisierung – nicht das Original“), stored as a rendition of the
 * voucher. Best effort — a rendering failure never blocks the draft; the in-app readable view stays available.
 */
async function storeVisualisation(
  ctx: { storage: { store: (b: Blob) => Promise<Id<"_storage">> } },
  inv: ReceivedInvoice,
): Promise<{ storageId: Id<"_storage">; sha256: string } | undefined> {
  try {
    const pdf = await renderEinvoiceVisualisation(inv);
    return { storageId: await storeBytes(ctx, pdf, "application/pdf"), sha256: await sha256Hex(pdf) };
  } catch {
    return undefined;
  }
}

const countryOfVatId = (vatId: string | undefined | null) =>
  vatId && /^[A-Z]{2}/i.test(vatId) ? vatId.slice(0, 2).toUpperCase() : undefined;

const supplyEndOf = (input: { supplyDate?: unknown; documentDate?: string }): string | undefined => {
  const s = input.supplyDate as
    | { kind: "date"; date: string }
    | { kind: "period"; to: string }
    | { kind: "month"; month: string }
    | undefined;
  if (s?.kind === "date") return s.date;
  if (s?.kind === "period") return s.to;
  return input.documentDate;
};

const ackWarning = (code: string, message: string): Warning => ({ code, message, acknowledge: true });

export const classify = systemAction({
  job: "inbox.classify",
  args: { id: v.id("inboxItems"), actorContext: vActorContext },
  handler: async (ctx, { id, actorContext: rawActor }): Promise<void> => {
    const actorContext = rawActor as ActorContext;
    const start = await ctx.runMutation(internal.inbox.beginInternal, { actorContext, id });
    if (!start.proceed) return;
    let input = await ctx.runQuery(internal.inbox.classifyInput, { id });
    if (!input) return;
    const warnings: Warning[] = [];
    const flags: string[] = [];

    // ── 1 e-mail-in: one item per message, attachments as original-derived files (INB-050/051) ──
    if (input.item.source === "email" && !input.item.mailParsed) {
      const emlIndex = input.item.files.findIndex((f) => f.role === "eml");
      const eml = input.item.files[emlIndex];
      if (eml) {
        const parsed = await parseInboundEmail(await bytesOf(ctx, eml.storageId));
        const files: {
          storageId: Id<"_storage">;
          sha256: string;
          name: string;
          mime: string;
          bytes: number;
          pages: number;
          role: "original";
          derivedFrom: number;
        }[] = [];
        const skipped: { name: string; mime: string; bytes: number; reason: "too_large" | "unsupported" }[] = [];
        const mailFlags: string[] = [];
        const mailWarnings: Warning[] = [];
        if (!parsed.ok) {
          mailFlags.push("mail_unparseable");
          mailWarnings.push({ code: "mail_unparseable", message: INBOX_MAIL_MESSAGES.unparseable });
        } else {
          for (const a of parsed.value.attachments) {
            if (a.decision === "classify" && a.bytes) {
              files.push({
                storageId: await storeBytes(ctx, a.bytes, a.mime),
                sha256: await sha256Hex(a.bytes),
                name: a.filename.slice(0, 255) || "anhang",
                mime: a.mime,
                bytes: a.bytes.byteLength,
                pages: pageCount(a.bytes, a.mime),
                role: "original",
                derivedFrom: emlIndex,
              });
            } else if (a.decision === "too_large" || a.decision === "unsupported") {
              skipped.push({ name: a.filename, mime: a.mime, bytes: a.size, reason: a.decision });
              if (a.decision === "too_large") {
                mailFlags.push("attachment_too_large");
                mailWarnings.push({ code: "attachment_too_large", message: INBOX_MAIL_MESSAGES.tooLarge(a.filename) });
              }
            }
          }
          if (files.length === 0 && !mailFlags.includes("attachment_too_large")) {
            mailWarnings.push({ code: "mail_no_attachment", message: INBOX_MAIL_MESSAGES.noAttachment });
          }
          if (!senderAllowed(parsed.value.from, input.allowlist)) {
            mailFlags.push("unknown_sender");
            mailWarnings.push({
              code: "unknown_sender",
              message: INBOX_MAIL_MESSAGES.unknownSender(parsed.value.from ?? "—"),
            });
          }
          if (parsed.value.authFailed) {
            mailFlags.push("sender_auth_failed");
            mailWarnings.push(ackWarning("sender_auth_failed", INBOX_MAIL_MESSAGES.authFailed));
          }
        }
        const p = parsed.ok ? parsed.value : null;
        const r = await ctx.runMutation(internal.inbox.mailParsedInternal, {
          actorContext,
          id,
          ...(p?.from ? { from: p.from } : {}),
          ...(p?.to ? { to: p.to } : {}),
          ...(p?.subject ? { subject: p.subject } : {}),
          ...(p?.messageId ? { messageId: p.messageId } : {}),
          ...(p?.text ? { mailText: p.text } : {}),
          files,
          skipped,
          flags: mailFlags,
          warnings: mailWarnings,
          duplicateText: INBOX_MAIL_MESSAGES.duplicateMessage("{date}"),
        });
        // A duplicate keeps its files (never dropped) and is not classified further (EC-INB-24, VOU-050).
        if (r.duplicate) return;
        input = await ctx.runQuery(internal.inbox.classifyInput, { id });
        if (!input) return;
      }
    }
    const item: Item = input.item;
    const files = item.files;
    const today = input.today;

    // ── 2/3 structured XML: the XML itself or the one embedded in a hybrid PDF (INB-021/022) ──
    const xmlIndex = files.findIndex((f) => f.mime === "application/xml" && f.role !== "embedded_attachment");
    const pdfIndex = files.findIndex((f) => f.mime === "application/pdf" && f.role === "original");
    const imageIndex = files.findIndex((f) => f.mime.startsWith("image/") && f.role === "original");
    let xml: { index: number; bytes: Uint8Array; hybridPdf?: Uint8Array } | null = null;
    let encrypted = false;
    if (xmlIndex >= 0) {
      xml = { index: xmlIndex, bytes: await bytesOf(ctx, (files[xmlIndex] as Item["files"][number]).storageId) };
      const pdfParentIdx = files[xmlIndex]?.derivedFrom;
      if (pdfParentIdx !== undefined && files[pdfParentIdx]?.mime === "application/pdf") {
        xml.hybridPdf = await bytesOf(ctx, (files[pdfParentIdx] as Item["files"][number]).storageId);
      }
    } else if (pdfIndex >= 0) {
      const pdf = await bytesOf(ctx, (files[pdfIndex] as Item["files"][number]).storageId);
      const found = await extractInvoiceXml(pdf);
      if (found.kind === "encrypted") {
        encrypted = true;
        flags.push("pdf_encrypted");
        warnings.push({ code: "pdf_encrypted", message: ENCRYPTED_PDF_MESSAGE });
      } else if (found.kind === "found") {
        const stored = await storeBytes(ctx, found.bytes, "application/xml");
        const r = await ctx.runMutation(internal.inbox.appendFilesInternal, {
          actorContext,
          id,
          files: [
            {
              storageId: stored,
              sha256: await sha256Hex(found.bytes),
              name: found.name,
              mime: "application/xml",
              bytes: found.bytes.byteLength,
              role: "extracted_xml",
              derivedFrom: pdfIndex,
            },
          ],
        });
        xml = { index: r.firstIndex, bytes: found.bytes, hybridPdf: pdf };
        if (found.others.length > 0) {
          warnings.push({ code: "einvoice_multiple_xml", message: multipleXmlMessage(found.name) });
        }
      }
    }

    if (xml) {
      const text = textOf(xml.bytes);
      const parsed = parseReceivedXml(text);
      const classification = xml.hybridPdf ? ("zugferd" as const) : ("xrechnung" as const);
      if (!parsed.ok) {
        // EC-INB-04 / Formatfehler: not processed as an E-Rechnung; the file stays the archived original.
        const finding: Finding = { ruleId: parsed.error.code, text: parsed.error.message, category: "format" };
        const verdict = verdictOf(false, [finding]);
        flags.push("einvoice_format_error");
        warnings.push(
          { code: "einvoice_format_error", message: RECEIVE_MESSAGES[parsed.error.code] ?? parsed.error.message },
          ackWarning("einvoice_faulty", faultyMessage(verdict)),
        );
        const syntax =
          invoiceSyntaxOf(text) ??
          (/CrossIndustryInvoice/.test(text)
            ? "cii"
            : /<([\w.-]+:)?(Invoice|CreditNote)[\s>]/.test(text)
              ? "ubl"
              : null);
        await ctx.runMutation(internal.inbox.finishInternal, {
          actorContext,
          id,
          classification,
          input: { direction: "expense" },
          ...(syntax
            ? {
                einvoice: {
                  syntax,
                  profile: "UNKNOWN",
                  notEInvoice: true,
                  xmlFileIndex: xml.index,
                  validation: {
                    acceptable: false,
                    category: "format",
                    tool: "parser",
                    at: Date.now(),
                    findings: [finding],
                  },
                },
              }
            : {}),
          flags,
          warnings,
        });
        return;
      }
      const inv: ReceivedInvoice = parsed.value.invoice;
      // BG-24 embedded attachments: extracted, hashed, listed; the XML stays byte-identical (INB-041).
      if (parsed.value.attachments.length > 0) {
        const extra = [];
        for (const a of parsed.value.attachments) {
          extra.push({
            storageId: await storeBytes(ctx, a.bytes, a.mime),
            sha256: await sha256Hex(a.bytes),
            name: a.filename.slice(0, 255) || "anlage",
            mime: a.mime,
            bytes: a.bytes.byteLength,
            role: "embedded_attachment" as const,
            derivedFrom: xml.index,
          });
        }
        await ctx.runMutation(internal.inbox.appendFilesInternal, { actorContext, id, files: extra });
      }
      // Validation (INB-024): KoSIT for XML, Mustang for the hybrid PDF; unavailable → retry, never „valid“.
      const validator = inboundValidator();
      const outcome = xml.hybridPdf ? await validator.validatePdf(xml.hybridPdf) : await validator.validateXml(text);
      let validation: {
        acceptable: boolean;
        category?: "ok" | "format" | "business_rule" | "content";
        tool: string;
        at: number;
        reportStorageId?: Id<"_storage">;
        reportSha256?: string;
        findings: Finding[];
        unavailable?: boolean;
      };
      if (outcome.kind === "unavailable") {
        const delay = nextRetryDelayMs(start.attempts, item.capturedAt, Date.now());
        if (delay !== null) {
          await ctx.runMutation(internal.inbox.retryInternal, {
            actorContext,
            id,
            delayMs: delay,
            warning: { code: "einvoice_sidecar_unavailable", message: INBOX_MESSAGES.sidecarUnavailable },
          });
          return;
        }
        validation = { acceptable: false, tool: "none", at: Date.now(), findings: [], unavailable: true };
        warnings.push(ackWarning("einvoice_not_validated", INBOX_MESSAGES.sidecarGaveUp));
      } else {
        const reportBytes = new TextEncoder().encode(outcome.report);
        const reportStorageId = await storeBytes(ctx, reportBytes, "application/json");
        const findings = [...outcome.findings, ...contentFindings(inv)];
        const verdict = verdictOf(outcome.acceptable, findings);
        validation = {
          acceptable: verdict.acceptable,
          category: verdict.category,
          tool: outcome.tool,
          at: Date.now(),
          reportStorageId,
          reportSha256: await sha256Hex(reportBytes),
          findings: verdict.findings.slice(0, 200),
        };
        if (!verdict.acceptable) {
          flags.push("einvoice_faulty");
          warnings.push(ackWarning("einvoice_faulty", faultyMessage(verdict)));
        }
      }
      if (inv.notEInvoice) {
        flags.push("not_einvoice");
        warnings.push({ code: "einvoice_not_einvoice", message: notEInvoiceMessage(inv.profile) });
      }
      const draft = receivedToVoucherDraft(inv, { germanRateBp: germanRateFromRules });
      warnings.push(...draft.warnings);
      if (input.company) {
        const addressee = checkAddressee(inv.buyer, input.company);
        if (addressee) warnings.push(ackWarning(addressee.code, addressee.message));
      }
      if (xml.hybridPdf) {
        const pdfText = await pdfTextLayer(xml.hybridPdf);
        const diff = pdfText ? compareWithPdfText(inv, pdfText) : [];
        if (diff.length > 0) warnings.push({ code: "einvoice_pdf_mismatch", message: pdfMismatchMessage(diff) });
      }
      // INB-047 / EC-INB-10: MINIMUM / BASIC-WL or a Formatfehler count as „keine E-Rechnung“ for the supplier duty.
      const supplyEnd = supplyEndOf(draft.input);
      const isEInvoice = !inv.notEInvoice && validation.category !== "format";
      if (supplyEnd) {
        const note = supplierEinvoiceObligation({
          isEInvoice,
          ...(inv.seller.address.countryCode ? { supplierCountryCode: inv.seller.address.countryCode } : {}),
          supplierIsKu: draft.input.taxRule === "kleinunternehmer_supplier",
          b2b: true,
          supplyEnd,
          grossEurCents: Math.abs(inv.totals.taxInclusiveCents),
        });
        if (note) warnings.push(note.severity === "warning" ? ackWarning(note.code, note.message) : note);
      }
      const a = inv.seller.address;
      const visualisation = await storeVisualisation(ctx, inv);
      await ctx.runMutation(internal.inbox.finishInternal, {
        actorContext,
        id,
        classification,
        input: draft.input,
        einvoice: JSON.parse(
          JSON.stringify({
            syntax: inv.syntax,
            profile: inv.profile,
            notEInvoice: inv.notEInvoice,
            xmlFileIndex: xml.index,
            model: inv,
            validation,
          }),
        ),
        flags,
        warnings,
        supplier: JSON.parse(
          JSON.stringify({
            name: inv.seller.name,
            vatId: inv.seller.vatId,
            taxNumber: inv.seller.taxNumber,
            iban: inv.payment.iban,
            email: inv.seller.email,
            electronicAddress: inv.seller.electronicAddress,
            address: a,
          }),
        ),
        ...(draft.payee ? { payee: draft.payee } : {}),
        ...(visualisation ? { visualisation } : {}),
        hintText: inv.lines.map((l) => l.name).join(" "),
      });
      return;
    }

    // ── 4 OCR (opt-in, INB-025/026) — never for hybrids or encrypted PDFs ──
    const ocrIndex = !encrypted ? (pdfIndex >= 0 ? pdfIndex : imageIndex) : -1;
    const classification = pdfIndex >= 0 ? ("pdf" as const) : imageIndex >= 0 ? ("image" as const) : ("other" as const);
    if (ocrIndex >= 0) {
      const cfg = input.ocr;
      if (!cfg.active || !cfg.encryptedSecrets) {
        warnings.push({ code: "ocr_disabled", message: OCR_MESSAGES.disabled });
      } else if (budgetExceeded(cfg.config.usage, cfg.config.monthlyBudget, today)) {
        warnings.push({
          code: "ocr_budget",
          message: "Monatsbudget der Belegerkennung erreicht – bitte manuell erfassen.",
        });
      } else if (await ctx.runQuery(internal.inbox.ocrStillActive, {})) {
        await ctx.runMutation(internal.inbox.ocrPendingInternal, { actorContext, id, pending: true });
        const file = files[ocrIndex] as Item["files"][number];
        const client = claudeOcrFor({
          apiKey: await decryptSecret(cfg.encryptedSecrets),
          ...(cfg.config.endpoint ? { baseURL: cfg.config.endpoint } : {}),
        });
        // SET-113: re-read the switch right before the request.
        const stillOn = await ctx.runQuery(internal.inbox.ocrStillActive, {});
        const r = stillOn
          ? await client.extract({
              model: cfg.config.model,
              file: { mime: file.mime, bytes: await bytesOf(ctx, file.storageId) },
              pageLimit: cfg.config.pageLimit,
            })
          : ({ ok: false, retryable: false, detail: "disabled" } as const);
        if (r.ok) {
          const assessment = postValidateExtraction(r.extraction, { today });
          for (const issue of assessment.issues) warnings.push({ code: issue.code, message: issue.message });
          if (assessment.confidence < OCR_REVIEW_THRESHOLD) flags.push("low_confidence");
          const prefill = assessment.prefill;
          const supplyEnd = supplyEndOf(prefill);
          const vatId = r.extraction.supplier.vatId ?? undefined;
          const domestic = countryOfVatId(vatId) === "DE" || (!vatId && !!r.extraction.supplier.taxNumber);
          if (supplyEnd && prefill.statedTotals?.grossCents !== undefined && domestic) {
            const note = supplierEinvoiceObligation({
              isEInvoice: false,
              supplierCountryCode: "DE",
              supplierIsKu: false,
              b2b: true,
              supplyEnd,
              grossEurCents: Math.abs(prefill.statedTotals.grossCents),
            });
            if (note) warnings.push(note.severity === "warning" ? ackWarning(note.code, note.message) : note);
          }
          await ctx.runMutation(internal.inbox.finishInternal, {
            actorContext,
            id,
            classification,
            input: JSON.parse(JSON.stringify({ direction: "expense", ...prefill })),
            confidence: assessment.confidence,
            flags,
            warnings,
            supplier: JSON.parse(
              JSON.stringify({
                name: r.extraction.supplier.name,
                vatId: prefill.supplierVatId,
                taxNumber: r.extraction.supplier.taxNumber,
                iban: prefill.supplierIban,
                email: r.extraction.supplier.email,
              }),
            ),
            ocr: JSON.parse(
              JSON.stringify({
                model: r.model,
                confidence: assessment.confidence,
                raw: r.raw,
                at: Date.now(),
                text: assessment.text,
                highlighted: assessment.highlighted,
              }),
            ),
            hintText: [r.extraction.categoryHint ?? "", ...r.extraction.lineItems.map((l) => l.description)].join(" "),
          });
          return;
        }
        if (r.retryable && start.attempts < 3) {
          await ctx.runMutation(internal.inbox.retryInternal, {
            actorContext,
            id,
            delayMs: 5 * 60_000 * start.attempts,
            warning: { code: "ocr_retry", message: "Belegerkennung vorübergehend nicht erreichbar – wird wiederholt." },
          });
          return;
        }
        warnings.push(
          r.detail === "disabled"
            ? { code: "ocr_disabled", message: OCR_MESSAGES.disabled }
            : { code: "ocr_failed", message: "Die Belegerkennung hat keine Daten geliefert. Bitte manuell erfassen." },
        );
      } else {
        warnings.push({ code: "ocr_disabled", message: OCR_MESSAGES.disabled });
      }
    }

    // ── 5 manual (INB-027) ──
    warnings.push({ code: "manual", message: INBOX_MESSAGES.manual });
    await ctx.runMutation(internal.inbox.finishInternal, {
      actorContext,
      id,
      classification,
      input: { direction: "expense" },
      flags,
      warnings,
      ...(item.subject ? { hintText: item.subject } : {}),
    });
  },
});

// ── R2 e-mail-in poll (INB-049/052) ─────────────────────────────────────────────────────────────────────

export const pollR2 = systemAction({
  job: "cron.inbox.pollR2",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }): Promise<{ imported: number; deleted: number; failed: number; skipped?: string }> => {
    if (process.env.IS_TEST === "true" && !force) return { imported: 0, deleted: 0, failed: 0, skipped: "test" };
    const bucket = inboxBucketFromEnv();
    if (!bucket) return { imported: 0, deleted: 0, failed: 0, skipped: "not_configured" };
    const state = await ctx.runQuery(internal.inbox.pollState, {});
    if (!state.enabled) return { imported: 0, deleted: 0, failed: 0, skipped: "disabled" };
    if (state.paused) return { imported: 0, deleted: 0, failed: 0, skipped: "paused" };
    const listed = await bucket.list();
    if (!listed.ok) {
      const unauthorized = listed.status === 401 || listed.status === 403 || listed.status === 404;
      await ctx.runMutation(internal.inbox.pollRunInternal, {
        outcome: unauthorized ? "unauthorized" : "failed",
        error: listed.detail,
      });
      return { imported: 0, deleted: 0, failed: 1 };
    }
    const now = Date.now();
    const plan = planPoll(listed.objects, now);
    if (plan.ignored.length > 0)
      console.warn(`inbox.pollR2: ${plan.ignored.length} Objekt(e) außerhalb von inbox/*.eml ignoriert`);
    let imported = 0;
    let deleted = 0;
    let failed = 0;
    for (const o of plan.batch) {
      try {
        const known = await ctx.runQuery(internal.inbox.r2ObjectKnown, { bucket: bucket.bucket, objectKey: o.key });
        if (!known) {
          const got = await bucket.get(o.key);
          if (!got.ok) {
            failed++;
            continue;
          }
          const etag = got.etag ?? o.etag;
          const storageId = await storeBytes(ctx, got.bytes, "message/rfc822");
          let r: { existed: boolean };
          try {
            r = await ctx.runMutation(internal.inbox.storeEmailInternal, {
              bucket: bucket.bucket,
              objectKey: o.key,
              ...(etag ? { etag } : {}),
              lastModified: got.lastModified || o.lastModified,
              file: {
                storageId,
                sha256: await sha256Hex(got.bytes),
                name: o.key.split("/").pop() ?? "mail.eml",
                mime: "message/rfc822",
                bytes: got.bytes.byteLength,
              },
            });
          } catch (e) {
            await ctx.storage.delete(storageId).catch(() => undefined);
            throw e;
          }
          if (r.existed)
            await ctx.storage.delete(storageId); // lost the race (EC-INB-23)
          else imported++;
        }
        // Only after the commit: the R2 object goes (a failure leaves it for the next run).
        const del = await bucket.delete(o.key);
        if (del.ok) deleted++;
        else failed++;
      } catch (e) {
        console.error(`inbox.pollR2 ${o.key}: ${e instanceof Error ? e.message : String(e)}`);
        failed++;
      }
    }
    const remaining = listed.objects.length - deleted - plan.ignored.length;
    await ctx.runMutation(internal.inbox.pollRunInternal, {
      outcome: failed > 0 && imported === 0 && deleted === 0 ? "failed" : "ok",
      objectsWaiting: Math.max(remaining, 0),
      staleCount: plan.staleCount,
      ...(plan.oldestStaleAt !== undefined ? { oldestStaleAt: plan.oldestStaleAt } : {}),
      ...(failed > 0 ? { error: `${failed} Objekt(e) nicht importiert` } : {}),
    });
    return { imported, deleted, failed };
  },
});

/** Einstellungen › Posteingang › „Verbindung testen“ (SET-110, INB-052): a list call with the inbox token. */
export const testR2 = action({
  permission: "integrations.manage",
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; detail: string; objects?: number; oldest?: number | null }> => {
    const bucket = inboxBucketFromEnv();
    if (!bucket) {
      const detail =
        "R2-Zugangsdaten fehlen (R2_ACCOUNT_ENDPOINT, R2_INBOX_BUCKET, R2_INBOX_ACCESS_KEY_ID, R2_INBOX_SECRET_ACCESS_KEY).";
      await ctx.runMutation(internal.inbox.r2TestInternal, { actorContext: ctx.actorContext, ok: false, detail });
      return { ok: false, detail };
    }
    const listed = await bucket.list();
    if (!listed.ok) {
      const detail = `Bucket ${bucket.bucket}: ${listed.detail}`;
      await ctx.runMutation(internal.inbox.r2TestInternal, {
        actorContext: ctx.actorContext,
        ok: false,
        detail,
        unauthorized: listed.status === 401 || listed.status === 403,
      });
      return { ok: false, detail };
    }
    const plan = planPoll(listed.objects, Date.now(), { batch: 1000 });
    const oldest = plan.batch[0]?.lastModified ?? null;
    const detail = `Bucket ${bucket.bucket}: ${plan.batch.length} Nachricht(en) warten`;
    await ctx.runMutation(internal.inbox.r2TestInternal, {
      actorContext: ctx.actorContext,
      ok: true,
      detail,
      objectsWaiting: plan.batch.length,
    });
    return { ok: true, detail, objects: plan.batch.length, oldest };
  },
});

/** Einstellungen › Belegerkennung › „Verbindung testen“ (SET-112): minimal request without business data. */
export const testClaude = action({
  permission: "integrations.manage",
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; detail: string; model?: string; latencyMs?: number }> => {
    const input = await ctx.runQuery(internal.inbox.ocrTestInput, {});
    if (!input.encryptedSecrets) {
      const detail = "Kein API-Schlüssel hinterlegt.";
      await ctx.runMutation(internal.inbox.recordTestInternal, {
        actorContext: ctx.actorContext,
        kind: "claude",
        ok: false,
        detail,
      });
      return { ok: false, detail };
    }
    const client = claudeOcrFor({
      apiKey: await decryptSecret(input.encryptedSecrets),
      ...(input.endpoint ? { baseURL: input.endpoint } : {}),
    });
    const r = await client.test(input.model);
    const detail = r.ok ? `${r.model} · ${r.latencyMs} ms` : r.detail.slice(0, 300);
    await ctx.runMutation(internal.inbox.recordTestInternal, {
      actorContext: ctx.actorContext,
      kind: "claude",
      ok: r.ok,
      detail,
    });
    return r.ok ? { ok: true, detail, model: r.model, latencyMs: r.latencyMs } : { ok: false, detail };
  },
});
