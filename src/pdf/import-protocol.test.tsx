import { PROTOCOL_INPUT, SHA } from "@test/factories/import-protocol";
import { pdfText } from "@test/golden/pdf-text";
import { describe, expect, test } from "vitest";
import { buildImportProtocol } from "@/domain/import/sevdesk/protocol";
import { renderImportProtocol } from "./import-protocol";

const sha256 = async (b: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");

describe("IMP-024 import protocol PDF", { timeout: 60_000 }, () => {
  test("IMP-024 renders the German protocol with full hashes, mapping, decisions and findings", async () => {
    const pdf = await renderImportProtocol(buildImportProtocol(PROTOCOL_INPUT));
    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe("%PDF-");
    const text = await pdfText(pdf);
    for (const s of [
      "Importprotokoll sevdesk-Export",
      "Import-ID",
      "imp123",
      "sevdesk-export-import@1",
      "inhaber@example.test (user:u1, Inhaber)",
      "Quelldateien",
      "Rechnungen_18.10.26.zip",
      "Spaltenzuordnung",
      "Kunden-Nr.",
      "Entscheidungen",
      "RE-{####}",
      "Befunde und Abweichungen",
      "E-IMP-32",
      "Offene Punkte",
      "Seite 1 von",
    ]) {
      expect(text).toContain(s);
    }
    // The hash may wrap inside its column; its characters are all there in order.
    expect(text.replace(/[\s|]/g, "")).toContain(SHA("c"));
  });

  test("IMP-024 the bytes are reproducible for the same import (archive hash is stable)", async () => {
    const p = buildImportProtocol(PROTOCOL_INPUT);
    const [a, b] = [await renderImportProtocol(p), await renderImportProtocol(p)];
    expect(await sha256(a)).toBe(await sha256(b));
  });
});
