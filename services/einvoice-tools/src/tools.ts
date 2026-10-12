/**
 * Adapters for the two Java tools: the KoSIT validator daemon (HTTP on localhost) and the Mustang CLI (one JVM per
 * call). Kept behind small interfaces so the HTTP layer is unit-testable without Java.
 */
import { spawn } from "node:child_process";

export interface KositResponse {
  status: number;
  body: string;
}

export interface KositClient {
  validate(xml: Uint8Array, signal?: AbortSignal): Promise<KositResponse>;
  /** `null` when the daemon is not reachable. */
  health(): Promise<{ version: string | null } | null>;
}

export function kositClient(baseUrl: string): KositClient {
  const root = baseUrl.replace(/\/$/, "");
  return {
    async validate(xml, signal) {
      const res = await fetch(`${root}/`, {
        method: "POST",
        headers: { "content-type": "application/xml" },
        body: xml,
        signal: signal ?? null,
      });
      return { status: res.status, body: await res.text() };
    },
    async health() {
      try {
        const res = await fetch(`${root}/server/health`, { signal: AbortSignal.timeout(2_000) });
        if (!res.ok) return null;
        const body = await res.text();
        if (!/<(?:\w+:)?status>UP</.test(body)) return null;
        return { version: /<(?:\w+:)?version>([^<]+)</.exec(body)?.[1] ?? null };
      } catch {
        return null;
      }
    },
  };
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type RunProcess = (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<ProcessResult>;

/** Runs `<command…> <args…>`, e.g. `java -Xmx1g -jar /opt/mustang/Mustang-CLI.jar --action validate …`. */
export function processRunner(command: string[]): RunProcess {
  const [bin, ...prefix] = command;
  if (!bin) throw new Error("empty command");
  return (args, { cwd, timeoutMs }) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, [...prefix, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => err.push(b));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
          timedOut,
        });
      });
    });
}

/** Minimal counting semaphore: Mustang starts a JVM per call, so parallelism is capped. */
export function limiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
