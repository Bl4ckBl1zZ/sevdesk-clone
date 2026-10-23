/**
 * Webhook endpoint URLs and the SSRF guard (05 §5.1, API-031). Pure.
 *
 * Decision (2026-10-23, documented in 05 §5.1): receivers are reached "over the internet or the tailnet". In
 * production (any instance whose SITE_URL is not a local development host):
 *  - the URL must be `https:`, without user info, and must not name a local host (`localhost`, `*.localhost`,
 *    `*.local`, `*.internal`, `*.home.arpa`);
 *  - every address the host resolves to — checked again before EVERY attempt, after DNS resolution — must be a
 *    public unicast address or a Tailscale address (CGNAT 100.64.0.0/10, the Tailscale ULA fd7a:115c:a1e0::/48);
 *  - loopback, private (RFC 1918, other ULAs), link-local incl. the cloud metadata address 169.254.169.254,
 *    unspecified, multicast, broadcast, documentation/benchmark ranges and IPv4 hidden in IPv6 (mapped, NAT64) are
 *    refused; redirects are never followed, so a public receiver cannot bounce the request inside.
 * In development (`https://app.localtest.me`, localhost) http and local receivers are allowed for testing.
 */

export type AddressClass = "public" | "tailnet" | "private" | "loopback" | "link_local" | "reserved" | "invalid";

const LOCAL_HOST_RE = /(^|\.)(localhost|local|internal|home\.arpa|localdomain)$/i;

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function classifyIpv4(o: number[]): AddressClass {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0) return "reserved"; // 0.0.0.0/8 "this network"
  if (a === 10) return "private";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link_local"; // incl. 169.254.169.254 (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "tailnet"; // 100.64.0.0/10 (Tailscale CGNAT)
  if (a === 192 && b === 0 && c === 0) return "reserved"; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return "reserved"; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return "reserved"; // benchmarking
  if (a === 198 && b === 51 && c === 100) return "reserved"; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return "reserved"; // TEST-NET-3
  if (a >= 224) return "reserved"; // multicast, 240/4, broadcast
  return "public";
}

/** Expands an IPv6 literal into 8 16-bit groups (embedded dotted IPv4 supported); null if malformed. */
function parseIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":");
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (!v4) return null;
    const hex = (n: number) => n.toString(16);
    s = `${s.slice(0, lastColon + 1)}${hex(((v4[0] ?? 0) << 8) | (v4[1] ?? 0))}:${hex(((v4[2] ?? 0) << 8) | (v4[3] ?? 0))}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const all = [...head, ...tail];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  if (halves.length === 1 && all.length !== 8) return null;
  if (halves.length === 2 && all.length > 7) return null;
  const nums = (gs: string[]) => gs.map((g) => Number.parseInt(g, 16));
  const zeros = new Array<number>(8 - all.length).fill(0);
  return halves.length === 2 ? [...nums(head), ...zeros, ...nums(tail)] : nums(head);
}

function classifyIpv6(g: number[]): AddressClass {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const v4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  if (g.every((x) => x === 0)) return "reserved"; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return "loopback";
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated): judged by the embedded IPv4
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return classifyIpv4(v4);
  if (g0 === 0x64 && g1 === 0xff9b) return classifyIpv4(v4); // NAT64 64:ff9b::/96
  if (g0 === 0xfd7a && g1 === 0x115c && g2 === 0xa1e0) return "tailnet"; // Tailscale ULA fd7a:115c:a1e0::/48
  if ((g0 & 0xfe00) === 0xfc00) return "private"; // other ULAs fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return "link_local"; // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return "reserved"; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return "reserved"; // documentation
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return "reserved"; // discard-only 100::/64
  if (g0 === 0x2002) return classifyIpv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]); // 6to4 embeds an IPv4
  return "public";
}

/** Classifies an IP literal (IPv4, IPv6, bracketed IPv6). */
export function classifyAddress(ip: string): AddressClass {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const v4 = parseIpv4(bare);
  if (v4) return classifyIpv4(v4);
  if (bare.includes(":")) {
    const v6 = parseIpv6(bare);
    return v6 ? classifyIpv6(v6) : "invalid";
  }
  return "invalid";
}

export function isIpLiteral(host: string): boolean {
  return classifyAddress(host) !== "invalid";
}

/** True when a delivery may connect to this resolved address. */
export function addressAllowed(ip: string, production: boolean): boolean {
  const c = classifyAddress(ip);
  if (c === "invalid") return false;
  if (!production) return true;
  return c === "public" || c === "tailnet";
}

export const URL_MESSAGES = {
  invalid: "Bitte eine gültige URL angeben (https://…).",
  https: "Webhook-URLs müssen in der Produktion HTTPS verwenden.",
  userinfo: "Die URL darf keine Zugangsdaten enthalten.",
  local: "Interne Adressen (localhost, private Netze, Link-Local, Metadaten-Dienst) sind als Webhook-Ziel nicht erlaubt.",
  length: "Die URL ist zu lang (max. 2.000 Zeichen).",
} as const;

/** Static URL check at save time (the address check after DNS runs again before every attempt). */
export function checkEndpointUrl(raw: string, production: boolean): { ok: true; url: string } | { ok: false; error: string } {
  const text = raw.trim();
  if (text.length > 2000) return { ok: false, error: URL_MESSAGES.length };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: URL_MESSAGES.invalid };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: URL_MESSAGES.invalid };
  if (production && u.protocol !== "https:") return { ok: false, error: URL_MESSAGES.https };
  if (u.username || u.password) return { ok: false, error: URL_MESSAGES.userinfo };
  if (!u.hostname) return { ok: false, error: URL_MESSAGES.invalid };
  if (production) {
    if (LOCAL_HOST_RE.test(u.hostname)) return { ok: false, error: URL_MESSAGES.local };
    if (isIpLiteral(u.hostname) && !addressAllowed(u.hostname, true)) return { ok: false, error: URL_MESSAGES.local };
  }
  u.hash = "";
  return { ok: true, url: u.toString() };
}

/** Development instances (local Caddy `localtest.me`, localhost) may deliver to http and local receivers. */
export function isProductionSite(siteUrl: string | undefined): boolean {
  if (!siteUrl) return true;
  try {
    const u = new URL(siteUrl);
    return !(/(^|\.)localtest\.me$/i.test(u.hostname) || u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return true;
  }
}
