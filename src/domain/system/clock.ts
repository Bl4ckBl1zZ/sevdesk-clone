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

export function clockSkewCheck(offsetMs: number | null): {
  status: "ok" | "warning" | "error" | "unknown";
  detail: string;
} {
  if (offsetMs === null) return { status: "unknown", detail: "Referenzzeit (NTP) nicht erreichbar." };
  const abs = Math.abs(offsetMs);
  if (abs > CLOCK_SKEW_BLOCK_MS) {
    return {
      status: "error",
      detail: `Die Serveruhr weicht um ${seconds(offsetMs, 0)} s ab. Fertigstellen ist gesperrt.`,
    };
  }
  if (abs > CLOCK_SKEW_WARN_MS)
    return { status: "warning", detail: `Die Serveruhr weicht um ${seconds(offsetMs, 1)} s ab.` };
  return { status: "ok", detail: `Abweichung ${seconds(offsetMs, 1)} s.` };
}

/** EC-027: finalisation guard (wired into the P1 finalisation transaction with the last measured offset). */
export function clockSkewBlocksFinalization(offsetMs: number | null): Issue | null {
  if (offsetMs === null || Math.abs(offsetMs) <= CLOCK_SKEW_BLOCK_MS) return null;
  return issue(
    "CLOCK_SKEW",
    `Die Serveruhr weicht um ${Math.round(Math.abs(offsetMs) / 1000)} s von der Referenzzeit ab. Fertigstellen ist gesperrt, bis die Uhrzeit korrigiert ist.`,
  );
}
