/**
 * Golden-file suite (07 §4, F04 §8.2 T-GLD-xx). Per case: the canonical snapshot, the CII (ZUGFeRD/Factur-X
 * EN 16931 or XRechnung CII), the XRechnung UBL and the PDF text. Files change only via `pnpm golden:update`
 * (vitest --update) with a written legal/layout reason in the PR (CLAUDE.md rule 11). KoSIT/Mustang validation of
 * the same outputs: test/integration/einvoice-validation.test.ts.
 */
import { describe, expect, test } from "vitest";
import { buildSnapshot } from "@/domain/documents/build-snapshot";
import { canonicalSnapshotJson } from "@/domain/documents/snapshot";
import { serializeEinvoice } from "@/domain/einvoice/serialize";
import { renderArtifacts } from "@/pdf/render-artifacts";
import { ciiFormat, goldenSnapshot, loadGoldenCases, ublFormat } from "./cases";
import { pdfText } from "./pdf-text";

const cases = loadGoldenCases();

describe("golden documents", () => {
  test("07 §4 the minimum P1 case list is present", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of cases) {
    test(`${c.file.id} ${c.dir}: ${c.file.title}`, { timeout: 30_000 }, async () => {
      const path = (name: string) => `./cases/${c.dir}/${name}`;
      if (c.file.expectError) {
        const r = buildSnapshot(c.input);
        expect(r.ok ? "ok" : r.error.code).toBe(c.file.expectError);
        return;
      }
      const snapshot = goldenSnapshot(c);
      const json = `${JSON.stringify(JSON.parse(canonicalSnapshotJson(snapshot)), null, 2)}\n`;
      await expect(json).toMatchFileSnapshot(path("expected.snapshot.json"));

      const cii = ciiFormat(snapshot);
      if (cii) await expect(serializeEinvoice(snapshot, cii).xml).toMatchFileSnapshot(path("expected.cii.xml"));
      const ubl = ublFormat(snapshot);
      if (ubl) await expect(serializeEinvoice(snapshot, ubl).xml).toMatchFileSnapshot(path("expected.ubl.xml"));

      const artifacts = await renderArtifacts(snapshot, c.layout, c.variant);
      await expect(await pdfText(artifacts.pdf)).toMatchFileSnapshot(path("expected.pdf.txt"));
    });
  }
});
