/**
 * Revenue reports (F08 RPT-007): by customer, product, month, cost centre or project; net and gross; based on
 * finalised documents (accrual — by document date or supply date) or on payments (cash, pro rata of the document).
 * Storno and Rechnungskorrekturen are netted (negative documents of the chain). Pure.
 *
 * By project (F11 PRJ-002): a line's project wins over the document's project; lines without either count as
 * „ohne Projekt“.
 */
import { allocateExact, roundHalfAway } from "../money";

const scale = (cents: number, num: number, den: number) =>
  den === 0 ? 0 : num === den ? cents : Number(roundHalfAway(BigInt(cents) * BigInt(num), BigInt(den)));

export type RevenueGroupBy = "customer" | "product" | "month" | "cost_center" | "project";
export type RevenueBasis = "document_date" | "supply_date" | "cash";

export interface RevenueDocument {
  id: string;
  number: string;
  type: string;
  documentDate: string;
  /** End of the supply (date, period end or month end). */
  supplyDate?: string;
  contactId?: string;
  contactName: string;
  costCenterId?: string;
  projectId?: string;
  netCents: number;
  grossCents: number;
  /** Item lines (net) for the product, cost centre and project groupings; Σ = netCents. */
  lines: { productId?: string; productName: string; netCents: number; costCenterId?: string; projectId?: string }[];
}

export interface RevenuePayment {
  documentId: string;
  date: string;
  /** Gross amount the payment settles (incl. Skonto etc.). */
  settlesCents: number;
}

export interface RevenueGroup {
  key: string;
  label: string;
  netCents: number;
  grossCents: number;
  documents: number;
}

export interface RevenueReport {
  groupBy: RevenueGroupBy;
  basis: RevenueBasis;
  from: string;
  to: string;
  groups: RevenueGroup[];
  totals: { netCents: number; grossCents: number };
  top: RevenueGroup[];
}

const monthLabel = (d: string) => `${d.slice(5, 7)}/${d.slice(0, 4)}`;

function keysOf(
  doc: RevenueDocument,
  groupBy: RevenueGroupBy,
  date: string,
  names: { costCenters?: ReadonlyMap<string, string>; projects?: ReadonlyMap<string, string> },
): { key: string; label: string; netCents: number }[] {
  if (groupBy === "customer")
    return [{ key: doc.contactId ?? "-", label: doc.contactName || "ohne Kontakt", netCents: doc.netCents }];
  if (groupBy === "month") return [{ key: date.slice(0, 7), label: monthLabel(date), netCents: doc.netCents }];
  const parts: {
    productId?: string;
    productName: string;
    netCents: number;
    costCenterId?: string;
    projectId?: string;
  }[] =
    doc.lines.length > 0
      ? doc.lines
      : [
          {
            productName: "ohne Produkt",
            netCents: doc.netCents,
            ...(doc.costCenterId ? { costCenterId: doc.costCenterId } : {}),
            ...(doc.projectId ? { projectId: doc.projectId } : {}),
          },
        ];
  if (groupBy === "project") {
    return parts.map((l) => {
      const p = l.projectId ?? doc.projectId;
      return {
        key: p ?? "-",
        label: p ? (names.projects?.get(p) ?? p) : "ohne Projekt",
        netCents: l.netCents,
      };
    });
  }
  if (groupBy === "product") {
    return parts.map((l) => ({
      key: ("productId" in l && l.productId) || `name:${l.productName}`,
      label: l.productName || "ohne Produkt",
      netCents: l.netCents,
    }));
  }
  return parts.map((l) => {
    const cc = l.costCenterId ?? doc.costCenterId;
    return {
      key: cc ?? "-",
      label: cc ? (names.costCenters?.get(cc) ?? cc) : "ohne Kostenstelle",
      netCents: l.netCents,
    };
  });
}

export function computeRevenue(input: {
  documents: readonly RevenueDocument[];
  payments?: readonly RevenuePayment[];
  groupBy: RevenueGroupBy;
  basis: RevenueBasis;
  from: string;
  to: string;
  top?: number;
  costCenters?: ReadonlyMap<string, string>;
  projects?: ReadonlyMap<string, string>;
}): RevenueReport {
  const groups = new Map<string, RevenueGroup & { docs: Set<string> }>();
  const add = (doc: RevenueDocument, date: string, factor: { num: number; den: number }) => {
    const keys = keysOf(doc, input.groupBy, date, { costCenters: input.costCenters, projects: input.projects });
    // net per key scaled by the factor; gross split pro rata of the net (largest remainder, exact totals)
    const scaledNet = scale(doc.netCents, factor.num, factor.den);
    const scaledGross = scale(doc.grossCents, factor.num, factor.den);
    const weights = keys.map((k) => BigInt(k.netCents));
    const nets = allocateExact(BigInt(scaledNet), weights).map(Number);
    const grosses = allocateExact(BigInt(scaledGross), weights).map(Number);
    keys.forEach((k, i) => {
      const g = groups.get(k.key) ?? {
        key: k.key,
        label: k.label,
        netCents: 0,
        grossCents: 0,
        documents: 0,
        docs: new Set(),
      };
      g.netCents += nets[i] ?? 0;
      g.grossCents += grosses[i] ?? 0;
      g.docs.add(doc.id);
      groups.set(k.key, g);
    });
  };
  if (input.basis === "cash") {
    const byId = new Map(input.documents.map((d) => [d.id, d]));
    for (const p of input.payments ?? []) {
      if (p.date < input.from || p.date > input.to) continue;
      const d = byId.get(p.documentId);
      if (!d || d.grossCents === 0) continue;
      add(d, p.date, { num: p.settlesCents, den: d.grossCents });
    }
  } else {
    for (const d of input.documents) {
      const date = input.basis === "supply_date" ? (d.supplyDate ?? d.documentDate) : d.documentDate;
      if (date < input.from || date > input.to) continue;
      add(d, date, { num: 1, den: 1 });
    }
  }
  const list = [...groups.values()]
    .map(({ docs, ...g }) => ({ ...g, documents: docs.size }))
    .filter((g) => g.netCents !== 0 || g.grossCents !== 0 || g.documents > 0)
    .sort((a, b) => (input.groupBy === "month" ? a.key.localeCompare(b.key) : b.netCents - a.netCents));
  const totals = list.reduce(
    (t, g) => ({ netCents: t.netCents + g.netCents, grossCents: t.grossCents + g.grossCents }),
    { netCents: 0, grossCents: 0 },
  );
  const top = [...list].sort((a, b) => b.netCents - a.netCents).slice(0, input.top ?? 10);
  return { groupBy: input.groupBy, basis: input.basis, from: input.from, to: input.to, groups: list, totals, top };
}
