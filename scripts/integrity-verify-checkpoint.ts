/**
 * `pnpm integrity:verify-checkpoint <datei.jws|https-URL> --public-key <datei> [--audit-export <audit.json>] [--convex]`
 * (F12 AUD-017). See scripts/integrity/verify-checkpoint.ts for the options; this file only wires file/URL reads
 * and the optional `npx convex run` lookup (needs the deployment's admin key in the environment, ops only).
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { verifyCheckpointCli } from "./integrity/verify-checkpoint";

async function readText(pathOrUrl: string): Promise<string> {
  if (/^https:\/\//.test(pathOrUrl)) {
    const res = await fetch(pathOrUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${pathOrUrl}: HTTP ${res.status}`);
    return res.text();
  }
  return readFile(pathOrUrl, "utf8");
}

function convexRun(fn: string, args: Record<string, unknown>): unknown {
  const out = execFileSync("npx", ["convex", "run", fn, JSON.stringify(args)], { encoding: "utf8" });
  return JSON.parse(out.trim() || "null");
}

const result = await verifyCheckpointCli(process.argv.slice(2), {
  readText,
  env: process.env,
  async convexChain(seq) {
    const entry = convexRun("integrity:entryAt", { seq }) as { seq: number; hash: string } | null;
    const state = convexRun("integrity:state", {}) as {
      head: { seq: number } | null;
      anchor: { seq: number } | null;
    };
    return {
      entry: entry ? { seq: entry.seq, hash: entry.hash } : null,
      headSeq: state.head?.seq ?? 0,
      ...(state.anchor ? { anchorSeq: state.anchor.seq } : {}),
    };
  },
});
for (const line of result.lines) console.log(line);
process.exit(result.exitCode);
