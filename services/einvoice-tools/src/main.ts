/**
 * Container entrypoint: starts the KoSIT validator daemon (localhost only) and the HTTP API.
 * Configuration comes from the environment; defaults match services/einvoice-tools/Dockerfile.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createApp } from "./server.ts";
import { kositClient, processRunner } from "./tools.ts";

const env = process.env;
const num = (name: string, fallback: number) => {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const JAVA = env.JAVA_BIN ?? "java";
const KOSIT_PORT = num("KOSIT_PORT", 8081);
const KOSIT_URL = env.KOSIT_URL ?? `http://127.0.0.1:${KOSIT_PORT}`;
const PORT = num("PORT", 8080);
const HOST = env.HOST ?? "0.0.0.0";

function log(entry: Record<string, unknown>) {
  console.info(JSON.stringify({ time: new Date().toISOString(), service: "einvoice-tools", ...entry }));
}

let daemon: ChildProcess | null = null;
let shuttingDown = false;

if (env.KOSIT_START !== "0") {
  const configDir = env.KOSIT_CONFIG_DIR ?? "/opt/kosit/config";
  daemon = spawn(
    JAVA,
    [
      `-Xmx${env.KOSIT_XMX ?? "768m"}`,
      "-jar",
      env.KOSIT_JAR ?? "/opt/kosit/validator.jar",
      "-s",
      `${configDir}/scenarios.xml`,
      "-r",
      configDir,
      "-D",
      "-G",
      "-H",
      "127.0.0.1",
      "-P",
      String(KOSIT_PORT),
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  daemon.on("exit", (code, signal) => {
    if (shuttingDown) return;
    // Without the daemon XML validation is impossible; let Docker restart the container.
    log({ level: "error", msg: "KoSIT daemon exited", code, signal });
    process.exit(1);
  });
}

const mustangCommand = env.MUSTANG_CMD
  ? (JSON.parse(env.MUSTANG_CMD) as string[])
  : [
      JAVA,
      `-Xmx${env.MUSTANG_XMX ?? "1g"}`,
      "-Dfile.encoding=UTF-8",
      "-jar",
      env.MUSTANG_JAR ?? "/opt/mustang/Mustang-CLI.jar",
    ];

const server = createApp({
  kosit: kositClient(KOSIT_URL),
  mustang: processRunner(mustangCommand),
  versions: {
    tools: env.EINVOICE_TOOLS_VERSION ?? "dev",
    kosit: env.KOSIT_VERSION ?? "unknown",
    xrechnungConfig: env.XRECHNUNG_CONFIG_VERSION ?? "unknown",
    mustang: env.MUSTANG_VERSION ?? "unknown",
  },
  maxBodyBytes: num("MAX_BODY_BYTES", 25 * 1024 * 1024),
  timeoutMs: num("TIMEOUT_MS", 120_000),
  mustangConcurrency: num("MUSTANG_CONCURRENCY", 2),
  log,
});

server.listen(PORT, HOST, () => log({ level: "info", msg: `listening on ${HOST}:${PORT}`, kosit: KOSIT_URL }));

function shutdown(signal: string) {
  shuttingDown = true;
  log({ level: "info", msg: `received ${signal}, shutting down` });
  daemon?.kill("SIGTERM");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
