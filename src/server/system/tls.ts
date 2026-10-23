import "server-only";
import { connect as tlsConnect } from "node:tls";

/**
 * F12 E-AUD-30b: expiry of the certificate served for `app.<BASE_DOMAIN>` (the Caddy wildcard certificate). Read by
 * the web server (Convex `fetch` cannot see certificate details); null when unreachable within the timeout.
 */
export type TlsPeer = { valid_to?: string };
export type TlsConnect = (
  opts: { host: string; port: number; servername: string; timeoutMs: number },
  done: (peer: TlsPeer | null) => void,
) => void;

const nodeConnect: TlsConnect = (opts, done) => {
  let settled = false;
  const finish = (peer: TlsPeer | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    done(peer);
  };
  const socket = tlsConnect({
    host: opts.host,
    port: opts.port,
    servername: opts.servername,
    rejectUnauthorized: false,
  });
  const timer = setTimeout(() => finish(null), opts.timeoutMs);
  socket.once("secureConnect", () => finish(socket.getPeerCertificate()));
  socket.once("error", () => finish(null));
};

export function certificateValidTo(
  host: string,
  opts: { port?: number; timeoutMs?: number; connect?: TlsConnect } = {},
): Promise<number | null> {
  const connect = opts.connect ?? nodeConnect;
  return new Promise((resolve) => {
    connect({ host, port: opts.port ?? 443, servername: host, timeoutMs: opts.timeoutMs ?? 3_000 }, (peer) => {
      const t = peer?.valid_to ? Date.parse(peer.valid_to) : Number.NaN;
      resolve(Number.isNaN(t) ? null : t);
    });
  });
}
