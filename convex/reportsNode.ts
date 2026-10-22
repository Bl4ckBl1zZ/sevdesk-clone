"use node";

import { v } from "convex/values";
import { sha256Hex } from "../src/domain/audit/chain";
import {
  bwaCsv,
  bwaDocument,
  ledgerCsv,
  ledgerDocument,
  oposCsv,
  oposDocument,
  revenueCsv,
  revenueDocument,
  susaCsv,
  susaDocument,
} from "../src/domain/reports/exports";
import { renderImportProtocol } from "../src/pdf/import-protocol";
import { internal } from "./_generated/api";
import { action } from "./functions";
import { appError } from "./lib/errors";

/**
 * F08 RPT-014 report downloads: SuSa, Kontenblatt, BWA, OPOS and revenue as CSV (BOM, `;`) or PDF/A-3b, each with
 * the RPT-001 footer (parameters, generation time, rule versions, „vorläufig“). Audited (AUD-001). The auditor gets
 * reports within the granted calendar years only (F12 AUD-023).
 */
const BWA_TITLE = { accrual: "BWA (Soll)", cash: "BWA (Ist / Zufluss-Abfluss)" } as const;
const REVENUE_TITLE = {
  customer: "Umsatz nach Kunde",
  product: "Umsatz nach Produkt",
  month: "Umsatz nach Monat",
  cost_center: "Umsatz nach Kostenstelle",
  project: "Umsatz nach Projekt",
} as const;

const yearsOf = (p: Record<string, unknown>): number[] =>
  ["from", "to", "asOf", "month"]
    .map((k) => p[k])
    .filter((x): x is string => typeof x === "string" && /^\d{4}/.test(x))
    .map((x) => Number(x.slice(0, 4)));

export const download = action({
  permission: "reports.read",
  args: {
    report: v.union(v.literal("susa"), v.literal("ledger"), v.literal("bwa"), v.literal("opos"), v.literal("revenue")),
    params: v.record(v.string(), v.union(v.string(), v.boolean())),
    format: v.union(v.literal("pdf"), v.literal("csv")),
  },
  handler: async (ctx, a): Promise<{ name: string; mime: string; data: ArrayBuffer }> => {
    if (ctx.role === "auditor") {
      const granted = ctx.actorContext.auditorYears ?? [];
      if (yearsOf(a.params).some((y) => !granted.includes(y)))
        throw appError("not_found", "Zeitraum nicht freigegeben.");
    }
    const input = await ctx.runQuery(internal.reports.reportInput, {
      report: a.report,
      params: a.params,
      ...(ctx.role === "auditor" ? { auditorYears: ctx.actorContext.auditorYears ?? [] } : {}),
    });
    const stamp = (input.data.meta.params.to ?? input.data.meta.params.stichtag ?? input.data.meta.params.monat ?? "")
      .toString()
      .replaceAll("-", "");
    const base = `${a.report === "opos" ? "OPOS" : a.report === "revenue" ? "Umsatz" : a.report === "ledger" ? "Kontenblatt" : a.report === "bwa" ? "BWA" : "SuSa"}_${stamp}`;
    let csv: string;
    let doc: Parameters<typeof renderImportProtocol>[0];
    switch (input.report) {
      case "susa":
        csv = susaCsv(input.data, input.data.meta);
        doc = susaDocument(input.data, input.data.meta, input.company);
        break;
      case "ledger":
        csv = ledgerCsv(input.data, input.data.meta);
        doc = ledgerDocument(input.data, input.data.meta, input.company);
        break;
      case "bwa":
        csv = bwaCsv(input.data.rows, input.data.meta);
        doc = bwaDocument(input.data.rows, input.data.meta, input.company, BWA_TITLE[input.data.variant]);
        break;
      case "opos":
        csv = oposCsv(input.data, input.data.meta);
        doc = oposDocument(input.data, input.data.meta, input.company);
        break;
      case "revenue":
        csv = revenueCsv(input.data, input.data.meta);
        doc = revenueDocument(input.data, input.data.meta, input.company, REVENUE_TITLE[input.data.groupBy]);
        break;
    }
    const bytes = a.format === "csv" ? new TextEncoder().encode(csv) : await renderImportProtocol(doc);
    const name = `${base}.${a.format}`;
    await ctx.runMutation(internal.reports.recordDownload, {
      report: a.report,
      format: a.format,
      name,
      sha256: await sha256Hex(bytes),
      actorContext: ctx.actorContext,
    });
    return {
      name,
      mime: a.format === "csv" ? "text/csv;charset=utf-8" : "application/pdf",
      data: bytes.slice().buffer as ArrayBuffer,
    };
  },
});
