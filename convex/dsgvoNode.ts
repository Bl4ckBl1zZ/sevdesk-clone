"use node";

import { createHash } from "node:crypto";
import { v } from "convex/values";
import { zipSync } from "fflate";
import type { Art30Record } from "../src/domain/privacy/art30";
import { auskunftReport, maskThirdPartyEmails } from "../src/domain/privacy/dsgvo";
import { renderImportProtocol } from "../src/pdf/import-protocol";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { systemAction } from "./functions";

/**
 * F12 PRV-013 / F02 CON-164 / DSGVO-03 access (Art. 15) and portability (Art. 20) export: ZIP with `daten.json`, the
 * document PDFs/XMLs (`belege/`) and `auskunft.pdf` generated from the Art. 30 record. Third-party e-mail addresses
 * are masked (E-PRV-17). Portability = the data the person provided (contact, addresses, channels).
 */

const enc = new TextEncoder();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const EXT: Record<string, string> = {
  pdf: "pdf",
  zugferd_pdf: "pdf",
  xrechnung_xml: "xml",
  letter_pdf: "pdf", // F05 receivable letters
  supplier_correction_letter: "pdf", // F06 INB-046
};
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

export const runExport = systemAction({
  job: "dsgvo.export",
  args: { jobId: v.id("jobs"), requestId: v.id("dsgvoRequests") },
  handler: async (ctx, { jobId, requestId }): Promise<boolean> => {
    try {
      const input = await ctx.runQuery(internal.dsgvo.exportInput, { requestId });
      if (!input) throw new Error("Kontakt nicht gefunden.");
      const { data } = input;
      const ownEmails = data.channels.filter((c) => c.type === "email").map((c) => c.value);
      const portable = data.kind === "portability";
      const payload = portable
        ? {
            format: "rechnungen-dsgvo/1",
            art: "Art. 20 DSGVO",
            contact: data.contact,
            addresses: data.addresses,
            channels: data.channels,
          }
        : {
            format: "rechnungen-dsgvo/1",
            art: "Art. 15 DSGVO",
            contact: data.contact,
            addresses: data.addresses,
            channels: data.channels,
            activities: data.activities.map((a) => ({ kind: a.kind, text: a.text ?? null, at: a._creationTime })),
            customerPrices: data.customerPrices,
            documents: data.documents,
            payments: data.payments,
            vatChecks: data.vatChecks,
            letters: data.letters,
            audit: data.audit,
          };
      const files: Record<string, Uint8Array> = {
        "daten.json": enc.encode(maskThirdPartyEmails(JSON.stringify(payload, null, 2), ownEmails)),
      };
      if (!portable) {
        const used = new Set<string>();
        for (const a of data.artifacts) {
          const ext = EXT[a.kind];
          if (!ext) continue;
          const blob = await ctx.storage.get(a.storageId as Id<"_storage">);
          if (!blob) continue;
          let name = `belege/${safe(a.number)}.${ext}`;
          for (let i = 2; used.has(name); i++) name = `belege/${safe(a.number)}_${i}.${ext}`;
          used.add(name);
          files[name] = new Uint8Array(await blob.arrayBuffer());
        }
        const report = auskunftReport({
          record: input.record as unknown as Art30Record,
          subject: data.subject,
          createdAt: Date.now(),
          counts: {
            Kontaktdaten: 1 + data.addresses.length + data.channels.length,
            Aktivitäten: data.activities.length,
            Belege: data.documents.length,
            Zahlungen: data.payments.length,
            Schreiben: data.letters.length,
            "USt-IdNr.-Prüfungen": data.vatChecks.length,
            Protokolleinträge: data.audit.length,
          },
        });
        files["auskunft.pdf"] = await renderImportProtocol(report);
      }
      const zip = zipSync(files, { level: 6 });
      const storageId = await ctx.storage.store(
        new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
      );
      await ctx.runMutation(internal.dsgvo.exportDone, {
        jobId,
        requestId,
        storageId,
        name: `${portable ? "datenuebertragung" : "auskunft"}-${safe(data.contact.number)}.zip`,
        sha256: sha(zip),
        bytes: zip.length,
      });
      return true;
    } catch (e) {
      await ctx.runMutation(internal.dsgvo.exportFailed, { jobId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },
});
