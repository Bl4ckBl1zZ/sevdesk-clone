import { calculateJwkThumbprint, exportJWK, importPKCS8, importSPKI, type JWK } from "jose";
import { checkpointPublicKeys, verifyWithKnownKeys } from "../../convex/lib/jws";
import {
  chainCheck,
  decodeCheckpoint,
  exportSegmentCheck,
  signatureCheck,
  summarizeChecks,
  type VerifyCheck,
} from "../../src/domain/audit/checkpoint-verify";

/**
 * `pnpm integrity:verify-checkpoint` (F12 AUD-017, SEC-04, GOBD-10) — verifies a signed daily checkpoint outside
 * the app, e.g. by the owner after a restore or by a Betriebsprüfer:
 *
 *   pnpm integrity:verify-checkpoint <datei.jws | https-URL> --public-key <schluessel.jwk.json|.pem>
 *        [--audit-export <audit-log.json>]   offline chain check against an AUD-008 JSON export
 *        [--convex]                          online chain check via `npx convex run integrity:entryAt` (admin key)
 *        [--instance <INSTANCE_NAME>]
 *
 * Without --public-key the key comes from CHECKPOINT_PUBLIC_JWK / CHECKPOINT_SIGNING_KEY_PEM (+ retired keys in
 * CHECKPOINT_RETIRED_PUBLIC_JWKS). The key fingerprint (RFC 7638 `kid`) is printed; it must match the one in the
 * Verfahrensdokumentation (chapter 14). Exit code 0 = confirmed, 1 = not confirmed, 2 = usage error.
 */

export interface CliIo {
  readText(pathOrUrl: string): Promise<string>;
  env: Readonly<Record<string, string | undefined>>;
  /** `--convex`: the live entry at `seq` and the head/anchor (via `npx convex run`). */
  convexChain?(
    seq: number,
  ): Promise<{ entry: { seq: number; hash: string } | null; headSeq: number; anchorSeq?: number }>;
}

export interface CliResult {
  exitCode: 0 | 1 | 2;
  lines: string[];
}

const USAGE =
  "Aufruf: pnpm integrity:verify-checkpoint <datei.jws|https-URL> --public-key <datei> [--audit-export <audit.json>] [--convex] [--instance <name>]";

function parseArgs(argv: readonly string[]) {
  const opts: { source?: string; publicKey?: string; auditExport?: string; convex: boolean; instance?: string } = {
    convex: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const next = () => argv[++i];
    if (a === "--public-key") opts.publicKey = next();
    else if (a === "--audit-export") opts.auditExport = next();
    else if (a === "--instance") opts.instance = next();
    else if (a === "--convex") opts.convex = true;
    else if (a === "--checkpoint") opts.source = next();
    else if (!a.startsWith("--") && !opts.source) opts.source = a;
    else throw new Error(`Unbekannte Option: ${a}`);
  }
  return opts;
}

/** A public key file: a JWK (JSON), a public SPKI PEM, or the PKCS#8 private key PEM (public part is used). */
export async function publicJwkFromText(text: string): Promise<JWK> {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const { d: _d, ...pub } = JSON.parse(trimmed) as JWK;
    return pub;
  }
  if (trimmed.includes("BEGIN PUBLIC KEY")) return exportJWK(await importSPKI(trimmed, "ES256", { extractable: true }));
  const { d: _d, ...pub } = await exportJWK(await importPKCS8(trimmed, "ES256", { extractable: true }));
  return pub;
}

export async function verifyCheckpointCli(argv: readonly string[], io: CliIo): Promise<CliResult> {
  const lines: string[] = [];
  let opts: ReturnType<typeof parseArgs>;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    return { exitCode: 2, lines: [String((e as Error).message), USAGE] };
  }
  if (!opts.source) return { exitCode: 2, lines: [USAGE] };

  const decoded = decodeCheckpoint(await io.readText(opts.source));
  if (!decoded.ok) return { exitCode: 1, lines: [`✗ ${decoded.detail}`] };
  const p = decoded.payload;
  lines.push(
    `Prüfpunkt vom ${p.date.split("-").reverse().join(".")} · bis seq ${p.lastSeq} · Instanz ${p.instance ?? "?"}`,
  );

  const keys = await checkpointPublicKeys(io.env.CHECKPOINT_SIGNING_KEY_PEM, io.env.CHECKPOINT_RETIRED_PUBLIC_JWKS);
  const extra = opts.publicKey ? await io.readText(opts.publicKey) : io.env.CHECKPOINT_PUBLIC_JWK;
  if (extra) {
    const jwk = await publicJwkFromText(extra);
    keys.set(await calculateJwkThumbprint(jwk), { ...jwk, alg: "ES256" });
  }
  if (keys.size === 0) {
    return { exitCode: 2, lines: [...lines, "Kein öffentlicher Schlüssel: --public-key angeben.", USAGE] };
  }
  lines.push(`Schlüssel-Fingerabdruck (kid) des Prüfpunkts: ${decoded.kid ?? "—"}`);
  lines.push(`Bekannte Schlüssel: ${[...keys.keys()].join(", ")}`);

  const checks: VerifyCheck[] = [signatureCheck(await verifyWithKnownKeys(decoded.jws, decoded.kid, keys))];
  if (opts.auditExport) {
    const exported = JSON.parse(await io.readText(opts.auditExport)) as { instance?: string; entries?: unknown };
    const instance = opts.instance ?? exported.instance;
    if (instance && p.instance && instance !== p.instance) {
      checks.push(chainCheck(p, null, { instance, headSeq: 0 }));
    } else {
      checks.push(await exportSegmentCheck(p, Array.isArray(exported.entries) ? exported.entries : []));
    }
  } else if (opts.convex && io.convexChain) {
    const live = await io.convexChain(p.lastSeq);
    checks.push(
      chainCheck(p, live.entry, {
        instance: opts.instance ?? p.instance ?? "",
        headSeq: live.headSeq,
        anchorSeq: live.anchorSeq,
      }),
    );
  } else {
    lines.push("Hinweis: Kettenprüfung übersprungen – --audit-export <audit.json> oder --convex angeben.");
  }

  for (const c of checks) lines.push(`${c.status === "ok" ? "✓" : "✗"} ${c.detail}`);
  const summary = summarizeChecks(checks);
  const chainChecked = checks.some((c) => c.id === "chain" || c.id === "instance");
  lines.push(summary.ok && !chainChecked ? "Signatur bestätigt (Kette nicht geprüft)." : summary.message);
  return { exitCode: summary.ok && chainChecked ? 0 : 1, lines };
}
