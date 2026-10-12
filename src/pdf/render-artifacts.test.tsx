import { makeSnapshot } from "@test/factories/snapshot";
import { pdfText } from "@test/golden/pdf-text";
import { describe, expect, test } from "vitest";
import { DEFAULT_LAYOUT } from "@/domain/documents/render-model";
import { serializeEinvoice } from "@/domain/einvoice/serialize";
import { readEmbeddedFiles } from "./embedded-files";
import { renderArtifacts } from "./render-artifacts";

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("renderArtifacts", { timeout: 60_000 }, () => {
  test("INV-21 ZUGFeRD: PDF/A-3b with factur-x.xml (Alternative) byte-equal to the returned XML", async () => {
    const s = makeSnapshot();
    const a = await renderArtifacts(s);
    expect(a.kind).toBe("zugferd_pdf");
    expect(a.pdfVariant).toBe("original");
    expect(a.fileNames).toEqual({ pdf: "RE-2026-0042.pdf", xml: "RE-2026-0042.xml" });
    const files = await readEmbeddedFiles(a.pdf);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("factur-x.xml");
    expect(files[0]?.afRelationship).toBe("Alternative");
    expect(Buffer.from(files[0]?.bytes ?? []).equals(Buffer.from(a.xml ?? []))).toBe(true);
    expect(new TextDecoder().decode(a.xml)).toBe(serializeEinvoice(s, "zugferd_en16931").xml);
    const raw = latin1(a.pdf);
    expect(raw).toContain("<pdfaid:part>3</pdfaid:part>");
    expect(raw).toContain("<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>");
    expect(raw).toContain("<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>");
    expect(raw).toContain("/OutputIntents");
    expect(a.sha256).toBe(a.pdfSha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("INV-21 ZUGFeRD XRECHNUNG profile embeds xrechnung.xml", async () => {
    const s = makeSnapshot({ references: { buyerReference: "EK-4711" }, einvoice: { format: "zugferd_xrechnung" } });
    const a = await renderArtifacts(s);
    const files = await readEmbeddedFiles(a.pdf);
    expect(files.map((f) => f.name)).toEqual(["xrechnung.xml"]);
    expect(latin1(a.pdf)).toContain("<fx:ConformanceLevel>XRECHNUNG</fx:ConformanceLevel>");
    expect(new TextDecoder().decode(files[0]?.bytes)).toContain("urn:xeinkauf.de:kosit:xrechnung_3.0");
  });

  test("DOC-32 rendering is deterministic: the archived original stays byte-identical, the Kopie differs", async () => {
    const s = makeSnapshot();
    const [a, b, copy] = await Promise.all([
      renderArtifacts(s),
      renderArtifacts(s),
      renderArtifacts(s, DEFAULT_LAYOUT, "copy"),
    ]);
    expect(b.sha256).toBe(a.sha256);
    expect(copy.pdfVariant).toBe("copy");
    expect(copy.sha256).not.toBe(a.sha256);
    expect(copy.xmlSha256).toBe(a.xmlSha256);
    expect(await pdfText(copy.pdf)).toContain("Kopie");
    expect(await pdfText(a.pdf)).not.toContain("Kopie");
  });

  test("INV-19 XRechnung: the XML is the primary artifact, the PDF is the Lesefassung", async () => {
    const s = makeSnapshot({
      buyer: { ...makeSnapshot().buyer, isPublicAuthority: true },
      references: { buyerReference: "04011000-1234512345-06" },
      einvoice: { format: "xrechnung_ubl", decision: "MUST_E" },
    });
    const a = await renderArtifacts(s);
    expect(a.kind).toBe("xrechnung_xml");
    expect(a.pdfVariant).toBe("reading");
    expect(a.sha256).toBe(a.xmlSha256);
    expect(a.fileNames).toEqual({ pdf: "RE-2026-0042_Lesefassung.pdf", xml: "RE-2026-0042.xml" });
    expect(await readEmbeddedFiles(a.pdf)).toEqual([]);
    expect(await pdfText(a.pdf)).toContain("Lesefassung – maßgeblich ist die XRechnung");
    expect(new TextDecoder().decode(a.xml)).toContain(
      '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
    );
  });

  test("DOC-30 format none and drafts: plain PDF/A-3b without XML", async () => {
    const s = makeSnapshot({ einvoice: { format: "none", decision: "NOT_REQUIRED" } });
    const a = await renderArtifacts(s);
    expect(a.kind).toBe("pdf");
    expect(a.xml).toBeUndefined();
    expect(await readEmbeddedFiles(a.pdf)).toEqual([]);
    expect(latin1(a.pdf)).toContain("<pdfaid:part>3</pdfaid:part>");
    const draft = await renderArtifacts(makeSnapshot(), DEFAULT_LAYOUT, "draft");
    expect(draft.kind).toBe("pdf");
    expect(await pdfText(draft.pdf)).toContain("ENTWURF – keine gültige Rechnung");
  });

  test("DOC-32 the archive file names replace slashes in the number", async () => {
    const a = await renderArtifacts(makeSnapshot({ number: "RE/2026/7", einvoice: { format: "none" } }));
    expect(a.fileNames.pdf).toBe("RE-2026-7.pdf");
  });
});
