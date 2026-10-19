import "server-only";
import { createSocket } from "node:dgram";
import { sntpOffsetMs, sntpRequest } from "@/domain/system/clock";

/** F12 AUD-019: default reference is the PTB (German national time, EU); configurable via `NTP_SERVER`. */
export const DEFAULT_NTP_SERVER = "ptbtime1.ptb.de";

/**
 * SNTP query (RFC 4330) for the clock-skew check (F01 SET-131, GOBD-22). UDP 123 to `NTP_SERVER`
 * (default ptbtime1.ptb.de); null when unreachable within the timeout.
 */
export function measureClockOffset(
  opts: { host?: string; port?: number; timeoutMs?: number; now?: () => number } = {},
): Promise<number | null> {
  const host = opts.host ?? process.env.NTP_SERVER ?? DEFAULT_NTP_SERVER;
  const port = opts.port ?? 123;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const now = opts.now ?? Date.now;
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    let t1 = 0;
    const done = (value: number | null) => {
      clearTimeout(timer);
      socket.close();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.once("error", () => done(null));
    socket.once("message", (msg) => done(sntpOffsetMs(new Uint8Array(msg), t1, now())));
    t1 = now();
    socket.send(sntpRequest(), port, host, (e) => {
      if (e) done(null);
    });
  });
}
