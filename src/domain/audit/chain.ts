import { canonicalize } from "./canonical";

/**
 * Audit hash chain (F12 AUD-004, 02 §4.6, GOBD-06):
 *   hash = SHA-256(prevHash ‖ JCS(entry without hash)), hex, lower case
 *   genesis prevHash = SHA-256("genesis:" + INSTANCE_NAME)
 * `seq` starts at 1 and is gapless. Convex system fields (`_id`, `_creationTime`) are not part of the entry.
 *
 * Uses WebCrypto (`crypto.subtle`, available in Node, the Convex runtime and edge-runtime); deterministic.
 */

const encoder = new TextEncoder();

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function genesisHash(instanceName: string): Promise<string> {
  return sha256Hex(`genesis:${instanceName}`);
}

/** The hashed content of a stored entry: everything except `hash` and Convex system fields. */
export function hashedContent(entry: Record<string, unknown>): Record<string, unknown> {
  const { hash: _hash, _id, _creationTime, ...rest } = entry;
  return rest;
}

export async function computeEntryHash(prevHash: string, entry: Record<string, unknown>): Promise<string> {
  return sha256Hex(prevHash + canonicalize(hashedContent(entry)));
}

export interface ChainEntry {
  seq: number;
  prevHash: string;
  hash: string;
  entity?: { table: string; id: string };
  [field: string]: unknown;
}

export type FindingSeverity = "warning" | "error";

export interface IntegrityFinding {
  kind: "chain_gap" | "chain_hash_mismatch" | "chain_link_broken" | "checkpoint_mismatch" | "checkpoint_signature";
  severity: FindingSeverity;
  detail: string;
  entity?: { table: string; id: string };
  firstBrokenSeq?: number;
}

export interface ChainCursor {
  /** seq expected next (1 for a fresh chain). */
  nextSeq: number;
  /** hash of the entry before `nextSeq` (genesis for seq 1). */
  prevHash: string;
}

export interface ChainVerification {
  cursor: ChainCursor;
  /** Highest seq whose hash and link verified, or `cursor.nextSeq - 1` of the input if none. */
  lastVerifiedSeq: number;
  findings: IntegrityFinding[];
}

/**
 * Verifies a contiguous page of entries (sorted by seq) starting at `cursor`. Pages can be chained by
 * passing the returned cursor to the next call, so the whole log never has to be in memory.
 * After a finding the verifier continues from the stored values, so every broken place is reported once.
 */
export async function verifyChainPage(entries: readonly ChainEntry[], cursor: ChainCursor): Promise<ChainVerification> {
  const findings: IntegrityFinding[] = [];
  let { nextSeq, prevHash } = cursor;
  let lastVerifiedSeq = nextSeq - 1;
  let broken = false;

  for (const entry of entries) {
    if (entry.seq !== nextSeq) {
      findings.push({
        kind: "chain_gap",
        severity: "error",
        detail:
          entry.seq > nextSeq
            ? `Lücke in der Protokollkette zwischen seq ${nextSeq - 1} und ${entry.seq}.`
            : `Doppelte oder ungeordnete seq ${entry.seq} (erwartet ${nextSeq}).`,
        firstBrokenSeq: Math.min(entry.seq, nextSeq),
      });
      broken = true;
    }
    if (entry.prevHash !== prevHash) {
      findings.push({
        kind: "chain_link_broken",
        severity: "error",
        detail: `Protokolleintrag seq ${entry.seq} verweist nicht auf den vorherigen Eintrag.`,
        ...(entry.entity ? { entity: { table: entry.entity.table, id: entry.entity.id } } : {}),
        firstBrokenSeq: entry.seq,
      });
      broken = true;
    }
    const recomputed = await computeEntryHash(entry.prevHash, entry);
    if (recomputed !== entry.hash) {
      findings.push({
        kind: "chain_hash_mismatch",
        severity: "error",
        detail: `Protokolleintrag seq ${entry.seq} wurde verändert oder beschädigt.`,
        ...(entry.entity ? { entity: { table: entry.entity.table, id: entry.entity.id } } : {}),
        firstBrokenSeq: entry.seq,
      });
      broken = true;
    }
    if (!broken) lastVerifiedSeq = entry.seq;
    nextSeq = entry.seq + 1;
    prevHash = entry.hash;
  }

  return { cursor: { nextSeq, prevHash }, lastVerifiedSeq, findings };
}
