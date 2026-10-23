/**
 * Clock skew (F01 SET-131, GOBD-22, EC-027). The web server measures its offset against NTP (SNTP, RFC 4330);
 * > 2 s warns, > 60 s blocks finalisation (document dates and audit timestamps would be wrong). Pure packet logic;
 * the UDP exchange lives in src/server/ntp.ts.
 */
import { type Issue, issue } from "../result";

export const CLOCK_SKEW_WARN_MS = 2_000;
export const CLOCK_SKEW_BLOCK_MS = 60_000;
const NTP_EPOCH_OFFSET_S = 2_208_988_800;

export function sntpRequest(): Uint8Array {
  const buf = new Uint8Array(48);
  buf[0] = 0x23; // LI 0, VN 4, mode 3 (client)
  return buf;
}

function readTimestamp(view: DataView, offset: number): number {
  const seconds = view.getUint32(offset) - NTP_EPOCH_OFFSET_S;
  const fraction = view.getUint32(offset + 4) / 2 ** 32;
  return (seconds + fraction) * 1000;
}

/** Offset of the local clock to the server (ms; positive = local clock behind), or null for an unusable reply. */
export function sntpOffsetMs(packet: Uint8Array, t1: number, t4: number): number | null {
  if (packet.length < 48) return null;
  const mode = (packet[0] ?? 0) & 0x07;
  const stratum = packet[1] ?? 0;
  if (mode !== 4 || stratum === 0 || stratum > 15) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const t2 = readTimestamp(view, 32);
  const t3 = readTimestamp(view, 40);
  return (t2 - t1 + (t3 - t4)) / 2;
}

const seconds = (ms: number, digits: number) =>
  (Math.abs(ms) / 1000).toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** F12 E-AUD-13 (§5.1): the time source could not be read. */
export const CLOCK_SOURCE_UNREACHABLE = "Zeitquelle nicht erreichbar – Abweichung kann nicht geprüft werden.";
/** E-AUD-13: without any good reading for this long, the unreachable source becomes a warning. */
export const CLOCK_SOURCE_WARN_AFTER_MS = 60 * 60 * 1000;

const blockedText = (offsetMs: number) =>
  `Fertigstellen gesperrt: Die Serverzeit weicht um ${seconds(offsetMs, 0)} s ab.`;

/** F12 §5.1 E-AUD-11 (> 2 s warning, GOBD-22) and E-AUD-12 (> 60 s blocks, EC-027); null = source unreachable. */
export function clockSkewCheck(offsetMs: number | null): {
  status: "ok" | "warning" | "error" | "unknown";
  detail: string;
} {
  if (offsetMs === null) return { status: "unknown", detail: CLOCK_SOURCE_UNREACHABLE };
  const abs = Math.abs(offsetMs);
  if (abs > CLOCK_SKEW_BLOCK_MS) return { status: "error", detail: blockedText(offsetMs) };
  if (abs > CLOCK_SKEW_WARN_MS) {
    return {
      status: "warning",
      detail: `Die Serverzeit weicht um ${seconds(offsetMs, 1)} s ab. Bitte Zeitsynchronisation (NTP) prüfen.`,
    };
  }
  return { status: "ok", detail: `Abweichung ${seconds(offsetMs, 1)} s.` };
}

/**
 * E-AUD-13: like `clockSkewCheck`, but an unreachable source turns into a warning once there has been no good
 * reading for an hour. `history` = earlier readings (any order); the outage counts from the last good reading, or
 * from the oldest unknown one when there never was a good reading.
 */
export function clockReadingCheck(
  offsetMs: number | null,
  history: readonly { at: number; offsetMs: number | null }[],
  now: number,
): ReturnType<typeof clockSkewCheck> {
  const check = clockSkewCheck(offsetMs);
  if (offsetMs !== null) return check;
  const good = history.filter((r) => r.offsetMs !== null).map((r) => r.at);
  const since = good.length > 0 ? Math.max(...good) : history.length > 0 ? Math.min(...history.map((r) => r.at)) : now;
  return now - since >= CLOCK_SOURCE_WARN_AFTER_MS ? { status: "warning", detail: CLOCK_SOURCE_UNREACHABLE } : check;
}

/** EC-027: finalisation guard (wired into the P1 finalisation transaction with the last measured offset). */
export function clockSkewBlocksFinalization(offsetMs: number | null): Issue | null {
  if (offsetMs === null || Math.abs(offsetMs) <= CLOCK_SKEW_BLOCK_MS) return null;
  return issue("CLOCK_SKEW", blockedText(offsetMs));
}
