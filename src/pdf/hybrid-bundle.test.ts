import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * The inbox classification runs `extractInvoiceXml` / `pdfTextLayer` in a Convex "use node" action, i.e. from an
 * esbuild bundle without node_modules (see convex-bundle.test.ts). pdfjs-dist must work there with its worker
 * registered on the main thread.
 */
const req = createRequire(import.meta.url);
const esbuild = createRequire(req.resolve("convex/package.json"))("esbuild") as {
  build(options: Record<string, unknown>): Promise<unknown>;
};
const root = fileURLToPath(new URL("../..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "convex-hybrid-bundle-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ENTRY = `
import { CII_V6, hybridPdf } from "@test/fixtures/einvoice-in/builders";
import { extractInvoiceXml, pdfTextLayer } from "@/pdf/hybrid";
const pdf = await hybridPdf([{ name: "factur-x.xml", xml: CII_V6 }], ["Rechnungsnummer: LF-2026-0815"]);
const x = await extractInvoiceXml(pdf);
const text = await pdfTextLayer(pdf);
console.log(JSON.stringify({ kind: x.kind, text }));
`;

describe("Convex node bundle (inbox)", { timeout: 180_000 }, () => {
  test("INB-022 hybrid XML extraction and the PDF text layer work from a self-contained bundle", async () => {
    const outfile = join(dir, "hybrid.mjs");
    await esbuild.build({
      stdin: { contents: ENTRY, resolveDir: root, sourcefile: "entry.ts", loader: "ts" },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "esnext",
      conditions: ["convex", "module"],
      tsconfig: join(root, "tsconfig.json"),
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      outfile,
      logLevel: "silent",
    });
    const out = execFileSync(process.execPath, [outfile], { cwd: dir, encoding: "utf8", timeout: 120_000 });
    const result = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { kind: string; text: string };
    expect(result.kind).toBe("found");
    expect(result.text).toContain("LF-2026-0815");
  });
});
