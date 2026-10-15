/**
 * Document-chain invariants (10-edge-cases §2): RI-06 (Storno), RI-07 (Rechnungskorrektur never below zero) and
 * RI-08 (final invoice deducts exactly the received amounts of every active advance). Pure;
 * convex/model/invariants.ts feeds it one row per sales document (VAT groups from the frozen snapshot).
 */
import { type GroupAmount, negateGroups, sumGroups } from "./advances";

export interface ChainFinding {
  id: "RI-06" | "RI-07" | "RI-08";
  severity: "ERROR";
  message: string;
}

export interface ChainInvariantRow {
  id: string;
  type: string;
  status: string;
  number?: string | undefined;
  /** Storno / Rechnungskorrektur: the document it refers to (`salesDocuments.correctsId`). */
  originalId?: string | undefined;
  correctionKind?: "credit" | "rectification" | undefined;
  /** VAT groups of the frozen snapshot (net/VAT per category and rate, signed as on the document). */
  groups: readonly GroupAmount[];
  /** Final invoice: `snapshot.deductions` (advance number + received amounts per group). */
  deductions?: readonly { advanceNumber: string; byGroup: readonly GroupAmount[] }[] | undefined;
  /** Advance/partial/final: the chain they belong to. */
  chainRootId?: string | undefined;
  /** Advance/partial: the final invoice that deducted it. */
  deductedInId?: string | undefined;
  /** Advance: accepted payment differences with VAT correction (Skonto, price reductions) — payments slice. */
  differences?: readonly GroupAmount[] | undefined;
}

const err = (id: ChainFinding["id"], message: string): ChainFinding => ({ id, severity: "ERROR", message });
const issued = (r: ChainInvariantRow) => r.status !== "draft";
const active = (r: ChainInvariantRow) => issued(r) && r.status !== "cancelled";
const same = (a: readonly GroupAmount[], b: readonly GroupAmount[]) => sumGroups(a, negateGroups(b)).length === 0;
const nameOf = (r: ChainInvariantRow) => r.number ?? r.id;

export function checkChains(rows: readonly ChainInvariantRow[]): ChainFinding[] {
  const out: ChainFinding[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const creditsOf = (id: string) =>
    rows.filter(
      (r) => r.type === "correction" && r.correctionKind !== "rectification" && r.originalId === id && active(r),
    );

  // RI-06
  const stornosOf = new Map<string, ChainInvariantRow[]>();
  for (const s of rows.filter((r) => r.type === "cancellation" && issued(r))) {
    if (s.status === "cancelled") out.push(err("RI-06", `Storno ${nameOf(s)} ist selbst storniert.`));
    const original = s.originalId ? byId.get(s.originalId) : undefined;
    if (!original) {
      out.push(err("RI-06", `Storno ${nameOf(s)} verweist auf keine Ursprungsrechnung.`));
      continue;
    }
    stornosOf.set(original.id, [...(stornosOf.get(original.id) ?? []), s]);
    if (sumGroups(original.groups, s.groups).length > 0) {
      out.push(err("RI-06", `Storno ${nameOf(s)} hebt ${nameOf(original)} nicht je USt-Gruppe auf.`));
    }
    if (original.status !== "cancelled") {
      out.push(err("RI-06", `${nameOf(original)} hat ein Storno, ist aber nicht als storniert markiert.`));
    }
  }
  for (const [id, list] of stornosOf) {
    if (list.length > 1) out.push(err("RI-06", `${byId.get(id)?.number ?? id} hat ${list.length} Stornos.`));
  }

  // RI-07
  const originals = new Set<string>();
  for (const c of rows.filter((r) => r.type === "correction" && issued(r))) {
    const original = c.originalId ? byId.get(c.originalId) : undefined;
    if (!original) out.push(err("RI-07", `Rechnungskorrektur ${nameOf(c)} verweist auf keine Ursprungsrechnung.`));
    else if (c.correctionKind !== "rectification") originals.add(original.id);
  }
  for (const id of originals) {
    const original = byId.get(id);
    if (!original) continue;
    const net = sumGroups(original.groups, ...creditsOf(id).map((c) => c.groups));
    for (const g of net) {
      if (g.netCents < 0 || g.vatCents < 0) {
        out.push(
          err(
            "RI-07",
            `${nameOf(original)}: Σ Rechnung + Korrekturen in USt-Gruppe ${g.category} ${g.rateBp / 100} % < 0.`,
          ),
        );
      }
    }
  }

  // RI-08
  const finals = rows.filter((r) => r.type === "final_invoice" && active(r));
  const advances = rows.filter((r) => (r.type === "advance_invoice" || r.type === "partial_invoice") && issued(r));
  for (const a of advances) {
    if (!a.deductedInId) continue;
    const f = byId.get(a.deductedInId);
    if (!f || !active(f) || f.type !== "final_invoice") {
      out.push(err("RI-08", `${nameOf(a)} verweist auf keine gültige Schlussrechnung.`));
    }
  }
  const deductedBy = new Map<string, string[]>();
  for (const f of finals) {
    const deductions = f.deductions ?? [];
    for (const d of deductions) deductedBy.set(d.advanceNumber, [...(deductedBy.get(d.advanceNumber) ?? []), f.id]);
    for (const a of advances.filter((x) => active(x) && f.chainRootId && x.chainRootId === f.chainRootId)) {
      const d = deductions.find((x) => x.advanceNumber === a.number);
      if (!d || a.deductedInId !== f.id) {
        out.push(err("RI-08", `${nameOf(a)} ist in Schlussrechnung ${nameOf(f)} nicht abgezogen.`));
        continue;
      }
      const received = sumGroups(a.groups, ...creditsOf(a.id).map((c) => c.groups), negateGroups(a.differences ?? []));
      if (!same(d.byGroup, received)) {
        out.push(err("RI-08", `${nameOf(f)}: Abzug von ${nameOf(a)} entspricht nicht den erhaltenen Zahlungen.`));
      }
    }
  }
  for (const [number, list] of deductedBy) {
    if (list.length > 1) out.push(err("RI-08", `${number} ist in ${list.length} Schlussrechnungen abgezogen.`));
  }
  return out;
}
