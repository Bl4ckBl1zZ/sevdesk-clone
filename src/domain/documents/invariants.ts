/**
 * Sales-document invariants over a database snapshot (10-edge-cases §2): RI-01 (finalised documents are complete and
 * their snapshot/artifact hashes verify), RI-02 (numbers ↔ register), RI-05 (totals arithmetic) and RI-19 (a `sent`
 * document has an effective mark over archived artifacts). Pure; convex/model/invariants.ts feeds it the database.
 */
import { vatCents } from "../money/vat";
import type { SnapshotTotals } from "./snapshot";

export interface DocumentFinding {
  id: "RI-01" | "RI-02" | "RI-05" | "RI-19";
  severity: "ERROR";
  message: string;
}

export interface ArtifactInvariantRow {
  id: string;
  sha256: string;
  /** sha256 (hex) of the bytes currently in file storage; null = file missing. */
  storedSha256: string | null;
}

export interface DocumentInvariantRow {
  id: string;
  type: string;
  status: string;
  number?: string;
  documentDate?: string;
  /** Invoice types must carry a supply date (UST-08). */
  hasSupplyDate: boolean;
  retentionUntil?: string;
  artifactStatus?: "pending" | "ready" | "blocked";
  snapshot?: { present: boolean; hashMatches: boolean; number?: string };
  artifacts: readonly ArtifactInvariantRow[];
  /**
   * Archived import (F09 IMP-003, EC-190): no snapshot (never re-rendered) and our validators are not applied
   * retroactively (e.g. a missing supply date) — number, date, retention and artifact hashes still hold.
   */
  imported?: boolean;
}

const INVOICE_TYPES = new Set([
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
  "cancellation",
  "correction",
]);

const err = (id: DocumentFinding["id"], message: string): DocumentFinding => ({ id, severity: "ERROR", message });

/** RI-01 */
export function checkFinalisedDocument(d: DocumentInvariantRow): DocumentFinding[] {
  if (d.status === "draft") return [];
  const out: DocumentFinding[] = [];
  const name = d.number ?? d.id;
  if (!d.number) out.push(err("RI-01", `Beleg ${d.id} ist festgeschrieben, hat aber keine Nummer.`));
  // EC-190: an archived import has no snapshot (never re-rendered).
  if (!d.imported) {
    if (!d.snapshot?.present) out.push(err("RI-01", `${name}: kein Snapshot vorhanden.`));
    else if (!d.snapshot.hashMatches)
      out.push(err("RI-01", `${name}: snapshotHash stimmt nicht mit dem Snapshot überein.`));
    else if (d.snapshot.number !== undefined && d.number !== undefined && d.snapshot.number !== d.number) {
      out.push(err("RI-01", `${name}: Nummer im Snapshot weicht ab.`));
    }
  }
  if (!d.documentDate) out.push(err("RI-01", `${name}: kein Belegdatum.`));
  if (INVOICE_TYPES.has(d.type) && !d.hasSupplyDate && !d.imported)
    out.push(err("RI-01", `${name}: kein Leistungsdatum.`));
  if (!d.retentionUntil) out.push(err("RI-01", `${name}: keine Aufbewahrungsfrist.`));
  if (d.artifactStatus === "ready" && d.artifacts.length === 0) {
    out.push(err("RI-01", `${name}: Dateien als bereit markiert, aber nicht archiviert.`));
  }
  for (const a of d.artifacts) {
    if (a.storedSha256 === null) out.push(err("RI-01", `${name}: archivierte Datei ${a.id} fehlt im Speicher.`));
    else if (a.storedSha256 !== a.sha256) out.push(err("RI-01", `${name}: Prüfsumme der Datei ${a.id} stimmt nicht.`));
  }
  return out;
}

export interface RegisterInvariantRow {
  number: string;
  normalized: string;
  documentId?: string;
  imported?: boolean;
}

/** RI-02 (sales documents only; register rows of other modules are ignored unless they point at a document). */
export function checkDocumentNumbers(
  docs: readonly Pick<DocumentInvariantRow, "id" | "status" | "number">[],
  register: readonly RegisterInvariantRow[],
): DocumentFinding[] {
  const out: DocumentFinding[] = [];
  const byId = new Map(docs.map((d) => [d.id, d]));
  for (const d of docs) {
    if (d.status === "draft" && d.number)
      out.push(err("RI-02", `Entwurf ${d.id} trägt bereits die Nummer ${d.number}.`));
  }
  const seen = new Map<string, number>();
  for (const r of register) seen.set(r.normalized, (seen.get(r.normalized) ?? 0) + 1);
  for (const [normalized, n] of seen) {
    if (n > 1) out.push(err("RI-02", `Nummer ${normalized} ist ${n}× im Nummernregister vergeben.`));
  }
  const registered = new Map<string, RegisterInvariantRow[]>();
  for (const r of register) {
    if (!r.documentId) continue;
    const list = registered.get(r.documentId) ?? [];
    list.push(r);
    registered.set(r.documentId, list);
    const d = byId.get(r.documentId);
    if (!d) {
      if (!r.imported) out.push(err("RI-02", `Nummer ${r.number} verweist auf keinen festgeschriebenen Beleg.`));
    } else if (d.status === "draft" || d.number !== r.number) {
      out.push(err("RI-02", `Nummer ${r.number} passt nicht zu Beleg ${d.number ?? d.id}.`));
    }
  }
  for (const d of docs) {
    if (d.status === "draft" || !d.number) continue;
    if (!registered.has(d.id)) out.push(err("RI-02", `${d.number} fehlt im Nummernregister.`));
  }
  return out;
}

/** RI-05 over the frozen totals; `itemNets` are the `netCents` of the non-optional item lines. */
export function checkTotals(name: string, itemNets: readonly number[], t: SnapshotTotals): DocumentFinding[] {
  const out: DocumentFinding[] = [];
  const sum = itemNets.reduce((a, b) => a + b, 0);
  if (sum !== t.lineNetSumCents) out.push(err("RI-05", `${name}: Σ Positionsnetto ${sum} ≠ ${t.lineNetSumCents}.`));
  if (t.lineNetSumCents - t.allowanceTotalCents + t.chargeTotalCents !== t.netCents) {
    out.push(err("RI-05", `${name}: Netto ≠ Positionssumme − Rabatte + Zuschläge.`));
  }
  let vatSum = 0;
  for (const g of t.byGroup) {
    vatSum += g.vatCents;
    const expected = vatCents(g.baseCents, g.rateBp);
    if (g.vatCents !== expected) {
      out.push(err("RI-05", `${name}: USt-Gruppe ${g.category} ${g.rateBp / 100} %: ${g.vatCents} ≠ ${expected}.`));
    }
  }
  if (t.byGroup.length > 0 && vatSum !== t.vatCents) out.push(err("RI-05", `${name}: Σ USt der Gruppen ≠ USt gesamt.`));
  if (t.netCents + t.vatCents !== t.grossCents) out.push(err("RI-05", `${name}: Brutto ≠ Netto + USt.`));
  if (t.grossCents - t.advancesDeductedGrossCents + t.roundingCents !== t.payableCents) {
    out.push(err("RI-05", `${name}: Zahlbetrag ≠ Brutto − Abschläge.`));
  }
  return out;
}

export interface MarkInvariantRow {
  id: string;
  kind: "mark_sent" | "retraction";
  retractsId?: string;
  sentOn: string;
  /** Berlin calendar date of `at`. */
  recordedOn: string;
  at: number;
  artifacts: readonly { artifactId: string; sha256: string }[];
}

/** RI-19 */
export function checkSentMarks(
  doc: { id: string; number?: string; status: string; finalizedOn?: string; imported?: boolean },
  rows: readonly MarkInvariantRow[],
  artifacts: readonly ArtifactInvariantRow[],
): DocumentFinding[] {
  // F09 §4.3.3: an imported document is archived as sent without a sendLog row (the export proves no dispatch).
  if (doc.status !== "sent" || doc.imported) return [];
  const name = doc.number ?? doc.id;
  const retracted = new Set(rows.filter((r) => r.kind === "retraction" && r.retractsId).map((r) => r.retractsId));
  const effective = rows.filter((r) => r.kind === "mark_sent" && !retracted.has(r.id));
  if (effective.length === 0)
    return [err("RI-19", `${name} ist als versendet markiert, hat aber keinen gültigen Versandvermerk.`)];
  const out: DocumentFinding[] = [];
  const hashes = new Map(artifacts.map((a) => [a.id, a.sha256]));
  for (const m of effective) {
    if (m.artifacts.length === 0 || m.artifacts.some((a) => hashes.get(a.artifactId) !== a.sha256)) {
      out.push(err("RI-19", `${name}: Versandvermerk ${m.id} verweist nicht auf archivierte Dateien.`));
    }
    if ((doc.finalizedOn && m.sentOn < doc.finalizedOn) || m.sentOn > m.recordedOn) {
      out.push(err("RI-19", `${name}: Versanddatum ${m.sentOn} liegt außerhalb des zulässigen Zeitraums.`));
    }
  }
  return out;
}
