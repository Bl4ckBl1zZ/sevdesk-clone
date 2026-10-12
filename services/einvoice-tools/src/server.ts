/**
 * einvoice-tools HTTP API (02 §8). Internal only: reachable as http://einvoice-tools:8080 on the compose network,
 * never published (no `expose`/`ports`, 08 §3.1).
 *
 *   POST /validate/xml   body: XML  → KoSIT daemon      → { acceptable, errors, warnings, infos, scenario, reportXml, … }
 *   POST /validate/pdf   body: PDF  → Mustang validate  → { valid, pdfaValid, xmlValid, errors, warnings, reportXml, … }
 *   POST /visualize      body: XML  → Mustang visualize → text/html (fallback viewer only)
 *   GET  /health                    → versions; 503 while the KoSIT daemon is down
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKositReport, parseMustangReport } from "./reports.ts";
import { type KositClient, limiter, type RunProcess } from "./tools.ts";

export interface Versions {
  /** Image version, e.g. `2026-08-31-1` (02 §8: the tag includes the config bundle date). */
  tools: string;
  kosit: string;
  xrechnungConfig: string;
  mustang: string;
}

export interface AppOptions {
  kosit: KositClient;
  mustang: RunProcess;
  versions: Versions;
  maxBodyBytes: number;
  timeoutMs: number;
  mustangConcurrency: number;
  log?: (entry: Record<string, unknown>) => void;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(payload);
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > max) throw new HttpError(413, "payload_too_large", `body exceeds ${max} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, "payload_too_large", `body exceeds ${max} bytes`);
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (body.length === 0) throw new HttpError(400, "empty_body", "request body is empty");
  return body;
}

function looksLikeXml(body: Buffer): boolean {
  const head = body.subarray(0, 64).toString("utf8").replace(/^﻿/, "").trimStart();
  return head.startsWith("<");
}

const isPdf = (body: Buffer) => body.subarray(0, 5).toString("latin1") === "%PDF-";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "eit-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createApp(opts: AppOptions): Server {
  const runMustang = limiter(opts.mustangConcurrency);
  const log = opts.log ?? ((e) => console.info(JSON.stringify(e)));

  async function validateXml(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req, opts.maxBodyBytes);
    if (!looksLikeXml(body)) throw new HttpError(415, "not_xml", "body is not an XML document");
    let kosit: Awaited<ReturnType<KositClient["validate"]>>;
    try {
      kosit = await opts.kosit.validate(body, AbortSignal.timeout(opts.timeoutMs));
    } catch (e) {
      throw new HttpError(503, "validator_unavailable", `KoSIT daemon not reachable: ${(e as Error).message}`);
    }
    const versions = { validatorVersion: opts.versions.kosit, configVersion: opts.versions.xrechnungConfig };
    // KoSIT daemon: 200 acceptable, 406 not acceptable, 422 processing error (e.g. not well-formed).
    if (kosit.status === 200 || kosit.status === 406) {
      const r = parseKositReport(kosit.body);
      send(res, 200, {
        acceptable: kosit.status === 200 && r.accepted,
        valid: r.valid,
        scenario: r.scenario,
        errors: r.errors,
        warnings: r.warnings,
        infos: r.infos,
        reportXml: kosit.body,
        ...versions,
      });
      return;
    }
    if (kosit.status === 422) {
      const r = parseKositReport(kosit.body);
      send(res, 422, { error: "processing_error", errors: r.errors, reportXml: kosit.body, ...versions });
      return;
    }
    throw new HttpError(502, "validator_error", `KoSIT daemon answered HTTP ${kosit.status}`);
  }

  async function validatePdf(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req, opts.maxBodyBytes);
    if (!isPdf(body)) throw new HttpError(415, "not_pdf", "body is not a PDF document");
    const run = await runMustang(() =>
      withTempDir(async (dir) => {
        await writeFile(join(dir, "input.pdf"), body);
        return opts.mustang(
          ["--no-notices", "--disable-file-logging", "--action", "validate", "--source", "input.pdf"],
          {
            cwd: dir,
            timeoutMs: opts.timeoutMs,
          },
        );
      }),
    );
    if (run.timedOut) throw new HttpError(504, "timeout", "Mustang validation timed out");
    const start = run.stdout.indexOf("<?xml");
    const reportXml = (start >= 0 ? run.stdout.slice(start) : run.stdout).trim();
    let r: ReturnType<typeof parseMustangReport>;
    try {
      r = parseMustangReport(reportXml);
    } catch {
      throw new HttpError(502, "validator_error", `Mustang produced no report (exit ${run.code})`);
    }
    send(res, 200, {
      // Mustang exits 0 only for a fully valid file; require both signals.
      valid: run.code === 0 && r.valid,
      pdfValid: r.pdf.valid,
      pdfaValid: r.pdf.pdfaCompliant === true,
      pdfaFlavour: r.pdf.flavour,
      xmlValid: r.xml.present && r.xml.valid,
      xmlPresent: r.xml.present,
      profile: r.xml.profile,
      errors: r.errors,
      warnings: r.warnings,
      reportXml,
      mustangVersion: opts.versions.mustang,
    });
  }

  async function visualize(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req, opts.maxBodyBytes);
    if (!looksLikeXml(body)) throw new HttpError(415, "not_xml", "body is not an XML document");
    const html = await runMustang(() =>
      withTempDir(async (dir) => {
        await writeFile(join(dir, "input.xml"), body);
        const run = await opts.mustang(
          [
            "--disable-file-logging",
            "--action",
            "visualize",
            "--language",
            "de",
            "--source",
            "input.xml",
            "--out",
            "out.html",
          ],
          { cwd: dir, timeoutMs: opts.timeoutMs },
        );
        if (run.timedOut) throw new HttpError(504, "timeout", "Mustang visualize timed out");
        try {
          return await readFile(join(dir, "out.html"), "utf8");
        } catch {
          throw new HttpError(422, "visualize_failed", `Mustang could not render the XML (exit ${run.code})`);
        }
      }),
    );
    send(res, 200, html, "text/html; charset=utf-8");
  }

  async function health(_req: IncomingMessage, res: ServerResponse) {
    const kosit = await opts.kosit.health();
    send(res, kosit ? 200 : 503, {
      status: kosit ? "ok" : "degraded",
      version: opts.versions.tools,
      kosit: { status: kosit ? "up" : "down", version: kosit?.version ?? opts.versions.kosit },
      xrechnungConfig: opts.versions.xrechnungConfig,
      mustang: opts.versions.mustang,
      node: process.versions.node,
    });
  }

  const routes: Record<string, Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>> = {
    "/validate/xml": { POST: validateXml },
    "/validate/pdf": { POST: validatePdf },
    "/visualize": { POST: visualize },
    "/health": { GET: health },
  };

  return createServer((req, res) => {
    const started = Date.now();
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = routes[path];
    const handler = route?.[req.method ?? "GET"];
    const done = (status: number) =>
      log({ level: status >= 500 ? "error" : "info", method: req.method, path, status, ms: Date.now() - started });

    if (!route) {
      send(res, 404, { error: "not_found" });
      return done(404);
    }
    if (!handler) {
      res.setHeader("allow", Object.keys(route).join(", "));
      send(res, 405, { error: "method_not_allowed" });
      return done(405);
    }
    handler(req, res)
      .then(() => done(res.statusCode))
      .catch((e: unknown) => {
        const err = e instanceof HttpError ? e : new HttpError(500, "internal_error", (e as Error).message);
        if (!res.headersSent) send(res, err.status, { error: err.code, message: err.message });
        else res.end();
        // Drain the rest of an oversized upload so the client sees the 413 instead of a reset.
        if (err.status === 413) req.resume();
        done(err.status);
      });
  });
}
