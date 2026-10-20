import type { GenericDatabaseReader } from "convex/server";
import { fiscalYearOf } from "../../src/domain/accounting/period";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { DataModel, TableNames } from "../_generated/dataModel";

/**
 * F12 AUD-023: an auditor session sees year-scoped data only for the granted fiscal years. Enforced centrally in
 * the `query` wrapper by wrapping `ctx.db`: `get` returns null and query results drop documents of other years
 * for the tables below; master data (contacts, products, accounts, settings) stays visible because it is needed
 * to understand the granted years. Documents without a date (drafts) are not part of any fiscal year and hidden.
 */

type Doc = Record<string, unknown>;

/** Table → the field that places a record in a fiscal year ("YYYY-MM-DD" string or epoch ms). */
export const AUDITOR_YEAR_FIELDS: Readonly<Partial<Record<TableNames, string>>> = {
  salesDocuments: "documentDate",
  vouchers: "documentDate",
  payments: "date",
  bankTransactions: "bookingDate",
  bankStatements: "periodFrom",
  cashTransfers: "date",
  journalEntries: "date",
  journalLines: "date",
  auditLog: "at",
  numberRegister: "assignedAt",
  gdpduExports: "year",
};

export function auditorKeep(table: string, doc: Doc, years: readonly number[], startMonth: number): boolean {
  const field = AUDITOR_YEAR_FIELDS[table as TableNames];
  if (!field) return true;
  const v = doc[field];
  if (field === "year") return typeof v === "number" && years.includes(v);
  const date = typeof v === "number" ? berlinCalendarDate(v) : typeof v === "string" ? v : null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return years.includes(fiscalYearOf(date, startMonth));
}

const TERMINAL = new Set(["collect", "take", "first", "unique", "paginate"]);

// biome-ignore lint/suspicious/noExplicitAny: wraps Convex's query builder chain generically
function wrapQuery(q: any, keep: (d: Doc) => boolean): any {
  return new Proxy(q, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        return async function* () {
          for await (const d of target) if (keep(d)) yield d;
        };
      }
      const v = Reflect.get(target, prop);
      if (typeof v !== "function") return v;
      if (TERMINAL.has(prop as string)) {
        switch (prop) {
          case "collect":
            return async () => ((await target.collect()) as Doc[]).filter(keep);
          case "take":
            return async (n: number) => ((await target.take(n)) as Doc[]).filter(keep);
          case "first":
            return async () => {
              for await (const d of target) if (keep(d)) return d;
              return null;
            };
          case "unique":
            return async () => {
              const d = await target.unique();
              return d && keep(d) ? d : null;
            };
          case "paginate":
            return async (o: unknown) => {
              const r = await target.paginate(o);
              return { ...r, page: (r.page as Doc[]).filter(keep) };
            };
        }
      }
      return (...args: unknown[]) => {
        const r = v.apply(target, args);
        return r && typeof r === "object" && typeof (r as { collect?: unknown }).collect === "function"
          ? wrapQuery(r, keep)
          : r;
      };
    },
  });
}

export function auditorScopedDb(
  db: GenericDatabaseReader<DataModel>,
  years: readonly number[],
  startMonth: number,
): GenericDatabaseReader<DataModel> {
  const scoped = Object.keys(AUDITOR_YEAR_FIELDS) as TableNames[];
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "get") {
        return async (...args: unknown[]) => {
          // db.get(id) and db.get(table, id)
          const id = (args.length > 1 ? args[1] : args[0]) as string;
          const doc = (await (target.get as (...a: unknown[]) => Promise<Doc | null>)(...args)) as Doc | null;
          if (!doc) return doc;
          const table =
            args.length > 1 ? (args[0] as TableNames) : scoped.find((t) => target.normalizeId(t, id) !== null);
          return table && !auditorKeep(table, doc, years, startMonth) ? null : doc;
        };
      }
      if (prop === "query") {
        return (table: TableNames) => {
          const q = target.query(table);
          return AUDITOR_YEAR_FIELDS[table] ? wrapQuery(q, (d) => auditorKeep(table, d, years, startMonth)) : q;
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
