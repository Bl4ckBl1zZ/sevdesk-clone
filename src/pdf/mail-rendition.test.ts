import { pdfText } from "@test/golden/pdf-text";
import { describe, expect, test } from "vitest";
import { MAIL_RENDITION_STAMP, renderMailRendition } from "./mail-rendition";

describe("INB-007 rendition of a mail without attachment", { timeout: 60_000 }, () => {
  test("INB-007 EC-INB-21 T06-011 the body is rendered as a PDF stamped as rendition, with the header fields; reproducible", async () => {
    const mail = {
      from: "rechnung@shop.example",
      to: "belege@in.example.de",
      subject: "Ihre Rechnung 4711 – jetzt online abrufen",
      date: "2026-10-20T08:15:00.000Z",
      text: `Guten Tag,\n\nIhre Rechnung 4711 über 59,90 € steht bereit: https://shop.example/rechnung/4711\n\n${"Viele Grüße ".repeat(400)}`,
    };
    const pdf = await renderMailRendition(mail, 1_760_000_000_000);
    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe("%PDF-");
    const text = await pdfText(pdf);
    for (const s of [
      MAIL_RENDITION_STAMP,
      "Von: rechnung@shop.example",
      "An: belege@in.example.de",
      "Betreff: Ihre Rechnung 4711 – jetzt online abrufen",
      "https://shop.example/rechnung/4711",
    ]) {
      expect(text).toContain(s);
    }
    expect(await renderMailRendition(mail, 1_760_000_000_000)).toEqual(pdf);
  });
});
