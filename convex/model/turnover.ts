import type { DocumentSnapshot } from "../../src/domain/documents/snapshot";
import {
  gesamtumsatzOfYear,
  ossRelevantNetCents,
  TURNOVER_DOC_TYPES,
  type TurnoverDoc,
  toEurCents,
  turnoverYear,
} from "../../src/domain/tax/turnover";
import type { CalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { getCompanyProfile } from "./companyProfile";
import { euerProfitCents } from "./euer";
import type { ReadCtx } from "./types";

/**
 * Turnover read model for the monitors (F08 TAX-012/013/017, F04 DOC-56): every finalised invoice-family document,
 * Storno and Rechnungskorrektur with its net (document currency + FX rate), supply year and OSS-relevant net in EUR.
 * Documents finalised before the OSS field existed are derived once per read from their snapshot and lines.
 */
export interface TurnoverRow extends TurnoverDoc {
  readonly id: Id<"salesDocuments">;
  readonly ossNetEurCents: number;
}

const supplyEndOf = (s: NonNullable<Doc<"salesDocuments">["supplyDate"]>): string =>
  s.kind === "date" ? s.date : s.kind === "period" ? s.to : `${s.month}-31`;

async function legacyOss(ctx: ReadCtx, d: Doc<"salesDocuments">): Promise<number> {
  if (!d.snapshotId || d.type === "cancellation" || d.type === "correction") return 0;
  const snap = await ctx.db.get(d.snapshotId);
  if (!snap) return 0;
  const s = JSON.parse(snap.json) as DocumentSnapshot;
  if (!s.buyer.isConsumer) return 0;
  const lines = await ctx.db
    .query("documentLines")
    .withIndex("by_document", (q) => q.eq("documentId", d._id))
    .collect();
  return ossRelevantNetCents({
    buyer: {
      isConsumer: s.buyer.isConsumer,
      isPublicAuthority: s.buyer.isPublicAuthority,
      hasValidVatId: !!s.buyer.vatId,
      countryCode: s.buyer.address?.countryCode ?? "DE",
    },
    deliveryCountry: s.delivery?.address?.countryCode,
    lines: lines
      .filter((l) => l.kind === "item" && !l.optional)
      .map((l) => ({
        productType: l.productType,
        placeOfSupplyRule: l.placeOfSupplyRule,
        netEurCents: toEurCents(l.lineNetCents ?? 0, d),
      })),
    date: (d.supplyDate ? supplyEndOf(d.supplyDate) : (d.documentDate ?? "2000-01-01")) as CalendarDate,
  });
}

/** A Storno takes its original's OSS sales out again; a Rechnungskorrektur is not netted (conservative: stricter). */
async function ossOf(ctx: ReadCtx, d: Doc<"salesDocuments">): Promise<number> {
  if (d.type === "cancellation") {
    const original = d.correctsId ? await ctx.db.get(d.correctsId) : null;
    return original ? -(original.ossNetEurCents ?? (await legacyOss(ctx, original))) : 0;
  }
  return d.ossNetEurCents ?? (await legacyOss(ctx, d));
}

export async function turnoverRows(
  ctx: ReadCtx,
  exclude?: Id<"salesDocuments">,
  opts: { withOss?: boolean } = {},
): Promise<TurnoverRow[]> {
  const out: TurnoverRow[] = [];
  // EC-065: proceeds of fixed-asset sales (AST-010 disposal linked to its invoice) are not part of the Gesamtumsatz.
  const assetSales = new Map<string, number>();
  for (const a of await ctx.db.query("assets").collect()) {
    const sale = a.disposal;
    if (sale?.kind !== "sale" || !sale.documentId || a.voidedAt !== undefined) continue;
    assetSales.set(sale.documentId, (assetSales.get(sale.documentId) ?? 0) + (sale.proceedsCents ?? 0));
  }
  for (const type of TURNOVER_DOC_TYPES) {
    for (const d of await ctx.db
      .query("salesDocuments")
      .withIndex("by_type_status_date", (q) => q.eq("type", type))
      .collect()) {
      if (d._id === exclude || d.status === "draft") continue;
      const deducted = (d.deductions ?? []).reduce((s, x) => s + x.byGroup.reduce((t, g) => t + g.netCents, 0), 0);
      const assetSale =
        assetSales.get(d._id) ?? (d.type === "cancellation" && d.correctsId ? -(assetSales.get(d.correctsId) ?? 0) : 0);
      out.push({
        id: d._id,
        type: d.type,
        status: d.status,
        ...(d.documentDate ? { documentDate: d.documentDate } : {}),
        ...(d.supplyDate ? { supplyEnd: supplyEndOf(d.supplyDate) } : {}),
        netCents: d.totals.netCents,
        currency: d.currency,
        ...(d.fxRateToEur ? { fxRateToEur: { rate: d.fxRateToEur.rate } } : {}),
        ...(deducted ? { deductedNetCents: deducted } : {}),
        ...(assetSale ? { assetSaleNetEurCents: assetSale } : {}),
        ossNetEurCents: opts.withOss === false ? 0 : await ossOf(ctx, d),
      });
    }
  }
  return out;
}

export interface TurnoverTotals {
  readonly year: number;
  readonly gesamtumsatz: { readonly priorYearCents: number; readonly currentYearCents: number };
  readonly oss: { readonly priorYearEurCents: number; readonly currentYearEurCents: number };
}

/** Prior and current calendar year totals (Gesamtumsatz and OSS) around `year`, without `exclude`. */
export async function turnoverTotals(
  ctx: ReadCtx,
  year: number,
  exclude?: Id<"salesDocuments">,
): Promise<TurnoverTotals> {
  const rows = await turnoverRows(ctx, exclude);
  const oss = (y: number) => rows.reduce((s, r) => (turnoverYear(r) === y ? s + r.ossNetEurCents : s), 0);
  return {
    year,
    gesamtumsatz: {
      priorYearCents: gesamtumsatzOfYear(rows, year - 1),
      currentYearCents: gesamtumsatzOfYear(rows, year),
    },
    oss: { priorYearEurCents: oss(year - 1), currentYearEurCents: oss(year) },
  };
}

/**
 * F01 SET-040: input of the threshold monitor (settings page and dashboard). Turnover = Gesamtumsatz from the
 * finalised documents; for the prior year the stored manual figure (SET-043) counts as well — the larger of both, so a
 * year the app holds only partly never hides a crossing. Profit = EÜR profit of the prior year (null until known).
 */
export async function thresholdMonitorInput(ctx: ReadCtx, today: CalendarDate) {
  const profile = await getCompanyProfile(ctx);
  const year = Number(today.slice(0, 4));
  const rows = await turnoverRows(ctx, undefined, { withOss: false });
  const manualPrior = profile?.priorYearTotalTurnoverCents.find((t) => t.year === year - 1)?.amountCents;
  const method = [...(profile?.taxationMethod ?? [])].sort((a, b) => a.validFrom.localeCompare(b.validFrom)).at(-1);
  const profit = profile ? await euerProfitCents(ctx, profile, year - 1) : null;
  return {
    today,
    priorYearCents: Math.max(gesamtumsatzOfYear(rows, year - 1), manualPrior ?? 0),
    currentYearCents: gesamtumsatzOfYear(rows, year),
    ...(profit !== null ? { priorYearProfitCents: profit } : {}),
    taxationMethod: method?.method ?? ("soll" as const),
    bookkeepingDuty: (profile?.profitMethod ?? []).some((p) => p.method === "bilanz"),
  };
}
