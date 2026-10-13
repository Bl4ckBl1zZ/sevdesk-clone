import { env } from "./env";

/**
 * Clock offset of the Convex runtime for the finalisation guard (F04 DOC-59, EC-027, GOBD-22). Convex actions cannot
 * speak NTP (UDP), so the offset is read from the HTTP `Date` header of `CLOCK_REFERENCE_URL` (1 s resolution, ample
 * for the 60 s threshold; the web server's NTP check in src/server/system/ntp.ts covers the 2 s warning). Without
 * the variable, or when the reference is unreachable, the offset is unknown (null) and finalisation is not blocked —
 * the integrity page shows the NTP status instead.
 */
export async function clockOffsetMs(now: () => number = Date.now): Promise<number | null> {
  const url = env("CLOCK_REFERENCE_URL");
  if (!url) return null;
  try {
    const t1 = now();
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3_000) });
    const t4 = now();
    const date = res.headers.get("date");
    if (!date) return null;
    const server = Date.parse(date);
    if (Number.isNaN(server)) return null;
    // The header is truncated to whole seconds: compare with the midpoint and allow for the truncation (+500 ms).
    return server + 500 - (t1 + t4) / 2;
  } catch {
    return null;
  }
}
