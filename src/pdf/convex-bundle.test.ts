import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * Convex "use node" actions run an esbuild bundle from a temporary directory without node_modules (convex CLI:
 * platform node, format esm, conditions ["convex", "module"]). Anything a dependency loads at run time through
 * `createRequire(import.meta.url)` is missing there — pdfkit (via @react-pdf) loaded its standard fonts that way and
 * every render failed in the backend with "Cannot find module '#standard-fonts/Helvetica'" (fixed by
 * patches/pdfkit@0.20.1.patch). This test bundles the renderer the same way and runs it outside the repository.
 */
const req = createRequire(import.meta.url);
// esbuild is the convex CLI's own dependency (not a direct one), so it is loaded from there with a minimal type.
const esbuild = createRequire(req.resolve("convex/package.json"))("esbuild") as {
  build(options: Record<string, unknown>): Promise<unknown>;
};
const root = fileURLToPath(new URL("../..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "convex-pdf-bundle-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ENTRY = `
import { makeSnapshot } from "@test/factories/snapshot";
import { renderArtifacts } from "@/pdf/render-artifacts";
const a = await renderArtifacts(makeSnapshot());
console.log(JSON.stringify({ kind: a.kind, pdfBytes: a.pdf.length, xmlBytes: a.xml?.length ?? 0 }));
`;

describe("Convex node bundle", { timeout: 180_000 }, () => {
  test("DOC-28 the PDF/A renderer works from a self-contained bundle without node_modules", async () => {
    const outfile = join(dir, "render.mjs");
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
    const result = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { kind: string; pdfBytes: number };
    expect(result.kind).toBe("zugferd_pdf");
    expect(result.pdfBytes).toBeGreaterThan(10_000);
  });
});
