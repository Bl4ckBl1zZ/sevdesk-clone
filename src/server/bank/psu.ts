/**
 * F07 BNK-107 „Jetzt abrufen“: the PSU (owner) headers that mark a fetch as owner-present (`Psu-Ip-Address`,
 * `Psu-User-Agent`; research 13 §4). Behind the public edge (Cloudflare → Traefik → Caddy) the client address is in
 * `CF-Connecting-IP`; on the tailnet Caddy sets `X-Forwarded-For`. Only forwarded to the bank — never used for rate
 * limiting or access decisions (CLAUDE.md rule 7).
 */
export interface PsuArgs {
  psuIpAddress?: string;
  psuUserAgent?: string;
}

const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;

export function psuFromHeaders(get: (name: string) => string | null): PsuArgs {
  const candidates = [get("cf-connecting-ip"), get("x-forwarded-for")?.split(",")[0], get("x-real-ip")];
  const ip = candidates.map((c) => c?.trim()).find((c): c is string => !!c && IP_RE.test(c));
  const ua = get("user-agent")?.trim().slice(0, 512);
  return { ...(ip ? { psuIpAddress: ip } : {}), ...(ua ? { psuUserAgent: ua } : {}) };
}
