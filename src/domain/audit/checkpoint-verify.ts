import { type ChainEntry, verifyChainPage } from "./chain";

/**
 * Checkpoint verification tool (F12 AUD-017, SEC-04, GOBD-10): a signed daily checkpoint (AUD-016) is verified
 * against (a) its ES256 signature with the instance's public key — the key fingerprint is the RFC 7638 `kid`
 * printed in the Verfahrensdokumentation (chapter 14) — and (b) the current audit chain: the entry `lastSeq` must
 * carry `lastHash`. Used by the „Prüfpunkt verifizieren“ upload (Convex, live chain) and the CLI
 * `pnpm integrity:verify-checkpoint` (offline against an AUD-008 audit export, or online). Pure: the signature
 * itself is checked by the caller (WebCrypto via jose), these functions only interpret the results.
 */

export interface CheckpointPayload {
  instance?: string;
  date: string;
  lastSeq: number;
  lastHash: string;
  [field: string]: unknown;
}

export type VerifyCheckId = "format" | "signature" | "instance" | "chain";

export interface VerifyCheck {
  id: VerifyCheckId;
  status: "ok" | "error";
  detail: string;
}

const germanDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split("-").reverse().join(".") : iso);

function b64urlJson(part: string): unknown {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

/** Decodes the compact JWS without trusting it (the signature is checked separately). */
export function decodeCheckpoint(
  raw: string,
): { ok: true; jws: string; kid: string | undefined; payload: CheckpointPayload } | { ok: false; detail: string } {
  const jws = raw.trim();
  const parts = jws.split(".");
  let header: { kid?: unknown };
  let payload: Record<string, unknown>;
  try {
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error("format");
    header = b64urlJson(parts[0] as string) as { kid?: unknown };
    payload = b64urlJson(parts[1] as string) as Record<string, unknown>;
  } catch {
    return { ok: false, detail: "Die Datei ist kein Prüfpunkt (JWS im Compact-Format erwartet)." };
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof payload.lastSeq !== "number" ||
    typeof payload.lastHash !== "string" ||
    typeof payload.date !== "string"
  ) {
    return { ok: false, detail: "Die Datei ist kein Prüfpunkt (lastSeq/lastHash/date fehlen)." };
  }
  return {
    ok: true,
    jws,
    kid: typeof header.kid === "string" ? header.kid : undefined,
    payload: payload as CheckpointPayload,
  };
}

export type SignatureResult =
  | { kind: "valid"; kid: string }
  | { kind: "invalid"; kid: string | undefined }
  | { kind: "unknown_key"; kid: string | undefined };

export function signatureCheck(r: SignatureResult): VerifyCheck {
  switch (r.kind) {
    case "valid":
      return { id: "signature", status: "ok", detail: `Signatur gültig (Schlüssel-Fingerabdruck ${r.kid}).` };
    case "invalid":
      return {
        id: "signature",
        status: "error",
        detail: "Signatur ungültig – der Prüfpunkt wurde verändert oder nicht von dieser Instanz signiert.",
      };
    case "unknown_key":
      return {
        id: "signature",
        status: "error",
        detail: `Der Schlüssel ${r.kid ?? "(ohne kid)"} ist nicht hinterlegt – Signatur kann nicht geprüft werden.`,
      };
  }
}

const hashMismatch = (p: CheckpointPayload): VerifyCheck => ({
  id: "chain",
  status: "error",
  detail: `Protokolleintrag seq ${p.lastSeq} stimmt nicht mit dem Prüfpunkt vom ${germanDate(p.date)} überein.`,
});

/** Live chain: the entry at `lastSeq` (null if absent), the head and a purge anchor (PRV-008). */
export function chainCheck(
  p: CheckpointPayload,
  entry: { seq: number; hash: string } | null,
  live: { instance: string; headSeq: number; anchorSeq?: number | undefined },
): VerifyCheck {
  if (p.instance !== undefined && p.instance !== live.instance) {
    return {
      id: "instance",
      status: "error",
      detail: `Der Prüfpunkt gehört zur Instanz „${p.instance}“, nicht zu „${live.instance}“.`,
    };
  }
  if (!entry) {
    if (live.anchorSeq !== undefined && p.lastSeq <= live.anchorSeq) {
      return {
        id: "chain",
        status: "ok",
        detail: `seq ${p.lastSeq} liegt im gelöschten Anfangsstück; der signierte Ankerpunkt seq ${live.anchorSeq} bestätigt die Kette.`,
      };
    }
    return {
      id: "chain",
      status: "error",
      detail: `Der aktuelle Datenstand endet vor dem Prüfpunkt vom ${germanDate(p.date)} (seq ${live.headSeq} < ${p.lastSeq}).`,
    };
  }
  if (entry.hash !== p.lastHash) return hashMismatch(p);
  return {
    id: "chain",
    status: "ok",
    detail: `Die Protokollkette enthält seq ${p.lastSeq} mit dem Hash des Prüfpunkts vom ${germanDate(p.date)}.`,
  };
}

/**
 * Offline (CLI): an AUD-008 JSON export (`entries` with seq/prevHash/hash) is re-verified from its first entry to
 * its end — every hash recomputed, every link checked — and must contain `lastSeq` with `lastHash`.
 */
export async function exportSegmentCheck(
  p: CheckpointPayload,
  entries: readonly Record<string, unknown>[],
): Promise<VerifyCheck> {
  const sorted = [...entries].sort((a, b) => Number(a.seq) - Number(b.seq)) as ChainEntry[];
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) {
    return { id: "chain", status: "error", detail: "Der Protokollauszug enthält keine Einträge." };
  }
  const res = await verifyChainPage(sorted, { nextSeq: first.seq, prevHash: first.prevHash });
  const broken = res.findings.find((f) => (f.firstBrokenSeq ?? Number.POSITIVE_INFINITY) <= p.lastSeq);
  if (broken) return { id: "chain", status: "error", detail: broken.detail };
  const at = sorted.find((e) => e.seq === p.lastSeq);
  if (!at) {
    return {
      id: "chain",
      status: "error",
      detail:
        p.lastSeq > last.seq
          ? `Der Protokollauszug endet bei seq ${last.seq} und enthält seq ${p.lastSeq} des Prüfpunkts nicht.`
          : `Der Protokollauszug beginnt bei seq ${first.seq} und enthält seq ${p.lastSeq} des Prüfpunkts nicht.`,
    };
  }
  if (at.hash !== p.lastHash) return hashMismatch(p);
  return {
    id: "chain",
    status: "ok",
    detail: `Der Protokollauszug (seq ${first.seq}–${last.seq}) ist lückenlos verkettet und enthält seq ${p.lastSeq} mit dem Hash des Prüfpunkts vom ${germanDate(p.date)}.`,
  };
}

export function summarizeChecks(checks: readonly VerifyCheck[]): { ok: boolean; message: string } {
  const failed = checks.find((c) => c.status === "error");
  return failed
    ? { ok: false, message: `Prüfpunkt nicht bestätigt: ${failed.detail}` }
    : { ok: true, message: "Prüfpunkt bestätigt." };
}
