import { describe, expect, test } from "vitest";
import {
  CLOCK_SKEW_BLOCK_MS,
  clockReadingCheck,
  clockSkewBlocksFinalization,
  clockSkewCheck,
  sntpOffsetMs,
  sntpRequest,
} from "./clock";

/** Builds an SNTP server reply with receive/transmit timestamps (ms since 1970). */
function reply(receiveMs: number, transmitMs: number): Uint8Array {
  const buf = new Uint8Array(48);
  buf[0] = 0x24; // LI 0, VN 4, mode 4 (server)
  buf[1] = 2; // stratum
  const view = new DataView(buf.buffer);
  const put = (offset: number, ms: number) => {
    const seconds = Math.floor(ms / 1000) + 2_208_988_800;
    view.setUint32(offset, seconds);
    view.setUint32(offset + 4, Math.round(((ms % 1000) / 1000) * 2 ** 32));
  };
  put(32, receiveMs);
  put(40, transmitMs);
  return buf;
}

describe("SET-131 GOBD-22 clock skew against NTP", () => {
  test("SET-131 the SNTP request is a 48-byte client packet (version 4, mode 3)", () => {
    const req = sntpRequest();
    expect(req).toHaveLength(48);
    expect(req[0]).toBe(0x23);
  });

  test("SET-131 the offset is ((t2 − t1) + (t3 − t4)) / 2", () => {
    const t1 = 1_791_800_000_000;
    // Server clock 3 s ahead, 40 ms round trip.
    const r = reply(t1 + 20 + 3000, t1 + 21 + 3000);
    expect(sntpOffsetMs(r, t1, t1 + 41)).toBeCloseTo(3000, -1);
    expect(sntpOffsetMs(new Uint8Array(10), t1, t1)).toBeNull();
    const bad = reply(t1, t1);
    bad[1] = 0; // stratum 0 = kiss-of-death
    expect(sntpOffsetMs(bad, t1, t1)).toBeNull();
  });

  test("SET-131 T-SET-100 EC-027 3 s skew warns; 61 s blocks finalisation with a German message", () => {
    expect(clockSkewCheck(800)).toMatchObject({ status: "ok" });
    expect(clockSkewCheck(-3000)).toMatchObject({ status: "warning" });
    expect(clockSkewCheck(61_000)).toMatchObject({ status: "error" });
    expect(clockSkewCheck(null)).toMatchObject({ status: "unknown" });
    expect(clockSkewBlocksFinalization(3000)).toBeNull();
    expect(clockSkewBlocksFinalization(CLOCK_SKEW_BLOCK_MS + 1000)).toMatchObject({
      code: "CLOCK_SKEW",
      message: "Fertigstellen gesperrt: Die Serverzeit weicht um 61 s ab.",
    });
  });

  test("E-AUD-11 a skew > 2 s is a warning with the GOBD-22 text", () => {
    expect(clockSkewCheck(-3000)).toEqual({
      status: "warning",
      detail: "Die Serverzeit weicht um 3,0 s ab. Bitte Zeitsynchronisation (NTP) prüfen.",
    });
    expect(clockSkewCheck(2000)).toMatchObject({ status: "ok" }); // exactly 2 s is still fine
  });

  test("E-AUD-12 a skew > 60 s refuses finalising and date-assigning actions (EC-027)", () => {
    expect(clockSkewCheck(-90_000)).toEqual({
      status: "error",
      detail: "Fertigstellen gesperrt: Die Serverzeit weicht um 90 s ab.",
    });
    expect(clockSkewCheck(60_000)).toMatchObject({ status: "warning" });
    expect(clockSkewBlocksFinalization(-90_000)?.message).toBe(
      "Fertigstellen gesperrt: Die Serverzeit weicht um 90 s ab.",
    );
  });

  test("E-AUD-13 an unreachable time source is unknown at first and a warning after 1 h without a good reading", () => {
    const now = 10 * 3_600_000;
    const unknown = "Zeitquelle nicht erreichbar – Abweichung kann nicht geprüft werden.";
    expect(clockSkewCheck(null)).toEqual({ status: "unknown", detail: unknown });
    // last good reading 50 min ago → still unknown (no alarm for a short outage)
    expect(clockReadingCheck(null, [{ at: now - 50 * 60_000, offsetMs: 300 }], now)).toEqual({
      status: "unknown",
      detail: unknown,
    });
    // last good reading 61 min ago → warning
    expect(
      clockReadingCheck(
        null,
        [
          { at: now - 10 * 60_000, offsetMs: null },
          { at: now - 61 * 60_000, offsetMs: 300 },
        ],
        now,
      ),
    ).toEqual({ status: "warning", detail: unknown });
    // never a good reading: the outage counts from the oldest unknown reading
    expect(clockReadingCheck(null, [{ at: now - 70 * 60_000, offsetMs: null }], now)).toMatchObject({
      status: "warning",
    });
    expect(clockReadingCheck(null, [], now)).toMatchObject({ status: "unknown" });
    // a measured offset is judged as usual
    expect(clockReadingCheck(5_000, [], now)).toMatchObject({ status: "warning" });
  });
});
