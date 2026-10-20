"use node";

import { v } from "convex/values";
import { sha256Hex } from "../src/domain/audit/chain";
import { ustvaSheetCsv, ustvaSheetDocument, zmSheetCsv, zmSheetDocument } from "../src/domain/exports/kennzahlen";
import { renderImportProtocol } from "../src/pdf/import-protocol";
import { internal } from "./_generated/api";
import { action } from "./functions";
import type { SheetInput } from "./kennzahlen";
import { appError } from "./lib/errors";

/**
 * F09 EXP-020 Kennzahlen sheet download: UStVA or ZM of a filing period as PDF/A-3b (react-pdf, Node) or CSV, with
 * the footer (generation time, rule versions, lock status, filing status). Reads only — the sheet values are F08's.
 * The auditor gets the sheets of the granted years only (F12 AUD-023; calendar year of the period).
 */
export const download = action({
  permission: "tax.read",
  args: {
    form: v.union(v.literal("ustva"), v.literal("zm")),
    period: v.string(),
    format: v.union(v.literal("pdf"), v.literal("csv")),
  },
  handler: async (ctx, a): Promise<{ name: string; mime: string; data: ArrayBuffer }> => {
    if (ctx.role === "auditor" && !(ctx.actorContext.auditorYears ?? []).includes(Number(a.period.slice(0, 4)))) {
      throw appError("not_found", "Zeitraum nicht freigegeben.");
    }
    const input: SheetInput | null = await ctx.runQuery(internal.kennzahlen.sheetInput, {
      form: a.form,
      period: a.period,
    });
    if (!input) throw appError("not_found", "Für diesen Zeitraum liegt keine Kennzahlen-Zuordnung vor.");
    const base = `${input.form === "ustva" ? "UStVA" : "ZM"}_${a.period}_Kennzahlen`;
    const audit = async (name: string, bytes: Uint8Array) =>
      ctx.runMutation(internal.kennzahlen.recordDownload, {
        ...a,
        name,
        sha256: await sha256Hex(bytes),
        actorContext: ctx.actorContext,
      });
    if (a.format === "csv") {
      const csv =
        input.form === "ustva" ? ustvaSheetCsv(input.sheet, input.footer) : zmSheetCsv(input.zm, input.footer);
      const bytes = new TextEncoder().encode(csv);
      await audit(`${base}.csv`, bytes);
      return { name: `${base}.csv`, mime: "text/csv;charset=utf-8", data: bytes.buffer as ArrayBuffer };
    }
    const doc =
      input.form === "ustva"
        ? ustvaSheetDocument(input.sheet, input.footer, input.company)
        : zmSheetDocument(input.zm, input.footer, input.company);
    const pdf = await renderImportProtocol(doc);
    await audit(`${base}.pdf`, pdf);
    return { name: `${base}.pdf`, mime: "application/pdf", data: pdf.slice().buffer as ArrayBuffer };
  },
});
