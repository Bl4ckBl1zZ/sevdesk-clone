import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createApp } from "../src/server.ts";
import { kositClient, type ProcessResult, type RunProcess } from "../src/tools.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name));
const report = (name: string) => readFileSync(join(fixtures, "reports", name), "utf8");

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * Fake KoSIT daemon: answers like validator 1.6.3 in daemon mode, keyed by the fixture content. No Java involved —
 * the bodies are reports captured from the real validator. They are read up front so a missing fixture fails the
 * test immediately instead of hanging the request inside the server callback.
 */
async function fakeKosit(up = true): Promise<string> {
  const reports = {
    accept: report("kosit-accept.xml"),
    reject: report("kosit-reject.xml"),
    processingError: report("kosit-422.xml"),
  };
  return listen(
    createServer((req, res) => {
      if (req.url === "/server/health") {
        res.writeHead(up ? 200 : 503, { "content-type": "application/xml" });
        res.end(
          up
            ? '<healthtype xmlns:ns2="x"><ns2:status>UP</ns2:status><ns2:application><ns2:version>1.6.3</ns2:version></ns2:application></healthtype>'
            : "",
        );
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const [status, xml] = body.includes("BuyerReference")
          ? [200, reports.accept]
          : body.includes("<ubl:Invoice")
            ? [406, reports.reject]
            : [422, reports.processingError];
        res.writeHead(status, { "content-type": "application/xml" });
        res.end(xml);
      });
    }),
  );
}

function fakeMustang(result: Partial<ProcessResult>): RunProcess & { calls: string[][] } {
  const calls: string[][] = [];
  const run: RunProcess = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
  return Object.assign(run, { calls });
}

interface ApiBody {
  acceptable?: boolean;
  errors?: { code: string }[];
  reportXml?: string;
  error?: string;
  kosit?: { status: string };
  [key: string]: unknown;
}
const json = (res: Response) => res.json() as Promise<ApiBody>;

async function app(opts: { kositUrl?: string; mustang?: RunProcess; maxBodyBytes?: number } = {}) {
  const kositUrl = opts.kositUrl ?? (await fakeKosit());
  return listen(
    createApp({
      kosit: kositClient(kositUrl),
      mustang: opts.mustang ?? fakeMustang({}),
      versions: { tools: "2026-08-31-1", kosit: "1.6.3", xrechnungConfig: "2026-08-31", mustang: "2.26.0" },
      maxBodyBytes: opts.maxBodyBytes ?? 1024 * 1024,
      timeoutMs: 5_000,
      mustangConcurrency: 1,
      log: () => {},
    }),
  );
}

describe("POST /validate/xml", () => {
  test("ER-12 a valid XRechnung UBL invoice is acceptable", async () => {
    const base = await app();
    const res = await fetch(`${base}/validate/xml`, { method: "POST", body: read("xrechnung-ubl-valid.xml") });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      acceptable: true,
      errors: [],
      validatorVersion: "1.6.3",
      configVersion: "2026-08-31",
    });
    expect(body.reportXml).toContain("<rep:accept>");
  });

  test("ER-12 an invalid XRechnung is not acceptable and lists BR-DE-15", async () => {
    const base = await app();
    const res = await fetch(`${base}/validate/xml`, { method: "POST", body: read("xrechnung-ubl-invalid.xml") });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.acceptable).toBe(false);
    expect(body.errors?.map((e: { code: string }) => e.code)).toContain("BR-DE-15");
  });

  test("ER-12 a KoSIT processing error is passed through as 422", async () => {
    const base = await app();
    const res = await fetch(`${base}/validate/xml`, { method: "POST", body: "<broken" });
    expect(res.status).toBe(422);
    expect((await json(res)).error).toBe("processing_error");
  });

  test("rejects an empty body (400), non-XML (415) and an oversized body (413)", async () => {
    const base = await app({ maxBodyBytes: 100 });
    expect((await fetch(`${base}/validate/xml`, { method: "POST", body: "" })).status).toBe(400);
    expect((await fetch(`${base}/validate/xml`, { method: "POST", body: "%PDF-1.7" })).status).toBe(415);
    expect((await fetch(`${base}/validate/xml`, { method: "POST", body: `<a>${"x".repeat(200)}</a>` })).status).toBe(
      413,
    );
  });

  test("ER-12 answers 503 when the KoSIT daemon is unreachable (finalisation stays blocked)", async () => {
    const base = await app({ kositUrl: "http://127.0.0.1:1" });
    const res = await fetch(`${base}/validate/xml`, { method: "POST", body: read("xrechnung-ubl-valid.xml") });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe("validator_unavailable");
  });
});

describe("POST /validate/pdf", () => {
  test("ER-12 a valid hybrid PDF is valid, PDF/A-compliant and has valid XML", async () => {
    const mustang = fakeMustang({ code: 0, stdout: report("mustang-hybrid-valid.xml") });
    const base = await app({ mustang });
    const res = await fetch(`${base}/validate/pdf`, { method: "POST", body: read("zugferd-xrechnung-valid.pdf") });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      valid: true,
      pdfaValid: true,
      xmlValid: true,
      profile: "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
      mustangVersion: "2.26.0",
    });
    expect(mustang.calls[0]).toEqual([
      "--no-notices",
      "--disable-file-logging",
      "--action",
      "validate",
      "--source",
      "input.pdf",
    ]);
  });

  test("ER-12 a PDF without embedded XML is invalid", async () => {
    const base = await app({ mustang: fakeMustang({ code: 255, stdout: report("mustang-pdf-without-xml.xml") }) });
    const res = await fetch(`${base}/validate/pdf`, { method: "POST", body: read("pdf-without-xml.pdf") });
    expect(await json(res)).toMatchObject({ valid: false, pdfaValid: true, xmlValid: false, xmlPresent: false });
  });

  test("rejects non-PDF bodies (415), reports timeouts (504) and missing reports (502)", async () => {
    const base = await app({ mustang: fakeMustang({ timedOut: true }) });
    expect((await fetch(`${base}/validate/pdf`, { method: "POST", body: "<xml/>" })).status).toBe(415);
    expect((await fetch(`${base}/validate/pdf`, { method: "POST", body: "%PDF-1.7 x" })).status).toBe(504);
    const broken = await app({ mustang: fakeMustang({ code: 1, stdout: "Exception in thread main" }) });
    expect((await fetch(`${broken}/validate/pdf`, { method: "POST", body: "%PDF-1.7 x" })).status).toBe(502);
  });
});

describe("GET /health and routing", () => {
  test("reports all bundled tool versions", async () => {
    const base = await app();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      status: "ok",
      version: "2026-08-31-1",
      kosit: { status: "up", version: "1.6.3" },
      xrechnungConfig: "2026-08-31",
      mustang: "2.26.0",
    });
  });

  test("is 503 while the KoSIT daemon is down", async () => {
    const base = await app({ kositUrl: await fakeKosit(false) });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    expect((await json(res)).kosit?.status).toBe("down");
  });

  test("unknown paths are 404, wrong methods 405", async () => {
    const base = await app();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const res = await fetch(`${base}/validate/xml`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
