import { CII_BASIC_WL, ciiXml, hybridPdf, plainPdf } from "@test/fixtures/einvoice-in/builders";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  eml,
  enableInbox,
  enableOcr,
  enc,
  ingest,
  installInboxFakes,
  item,
  putR2,
  runRetry,
  settleInbox,
  validatorPasses,
  voucherOf,
} from "./inbox.fixtures";
import { CLAUDE_FAKE_EXTRACTION, claudeFake, claudeFakeMessage } from "./lib/claudeOcr";
import { inboundValidatorFake } from "./lib/einvoiceInbound";
import { errorCode } from "./lib/errors";
import { memoryInbox } from "./lib/r2Inbox";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";
import { OWNER, pdfBytes, setupCompany } from "./vouchers.fixtures";

/**
 * F06 classification pipeline and R2 poll branches (convex/inboxNode.ts): e-mail attachments, encrypted and
 * multi-XML hybrids, PDF/XML mismatch, Formatfehler syntax detection, sidecar give-up, OCR budget/retry/failure,
 * poll and connection-test failures. OCR, validator and R2 run on the module fakes (inbox.fixtures).
 */

installInboxFakes();

type Owner = Awaited<ReturnType<TestT["asUser"]>>;

async function errorOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const data = ((e as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
    return { code: errorCode(e) ?? "unknown", message: String(data.message ?? (e as Error).message) };
  }
  throw new Error("expected an error");
}

async function setup(t: TestT): Promise<Owner> {
  await setupCompany(t);
  return t.asUser("owner");
}

async function asBuyer(t: TestT) {
  await t.model(OWNER, (ctx) =>
    patchCompanyProfile(
      ctx,
      { name: "Beispiel Kunde GmbH", vatId: "DE811907980" },
      { action: "settings.company.update" },
    ),
  );
}

const passing = () => {
  inboundValidatorFake.impl = {
    validateXml: async () => validatorPasses(),
    validatePdf: async () => validatorPasses("mustang 2.26"),
  };
};

const codes = (it: { warnings?: { code: string }[] }) => (it.warnings ?? []).map((w) => w.code);
const poll = (t: TestT) => t.action(internal.inboxNode.pollR2, { force: true });
const items = (t: TestT) => t.run((ctx) => ctx.db.query("inboxItems").collect());

describe("e-mail attachments (INB-050, INB-007, EC-INB-06, EC-INB-21)", () => {
  test("INB-050 EC-INB-06 a ZIP is listed as unsupported; a nameless PDF becomes „anhang“; a mail without From is an unknown sender", async () => {
    const t = makeT();
    const owner = await setup(t);
    await enableInbox(owner, { allowlist: "@lieferant.de" });
    const pdf = await plainPdf(["Rechnung ohne Namen"]);
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]);
    const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
    const raw = [
      "To: belege@in.example.de",
      "Subject: Unterlagen",
      "Message-ID: <ohne-from@x.de>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Anbei.",
      "--B",
      'Content-Type: application/zip; name="belege.zip"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="belege.zip"',
      "",
      b64(zip),
      "--B",
      "Content-Type: application/pdf",
      "Content-Transfer-Encoding: base64",
      "Content-Disposition: attachment",
      "",
      b64(pdf),
      "--B--",
      "",
    ].join("\r\n");
    putR2("inbox/1-zip.eml", enc(raw));
    expect(await poll(t)).toMatchObject({ imported: 1 });
    await settleInbox(t);
    const [it] = await items(t);
    expect(it?.skippedAttachments).toEqual([expect.objectContaining({ name: "belege.zip", reason: "unsupported" })]);
    expect(it?.files[0]?.name).toBe("1-zip.eml");
    expect(it?.files[1]).toMatchObject({ role: "original", derivedFrom: 0, mime: "application/pdf" });
    expect(it?.files[1]?.name).toMatch(/^anhang/);
    expect(it?.flags).toContain("unknown_sender");
    expect(it?.warnings?.find((w) => w.code === "unknown_sender")?.message).toContain("—");
    expect(it?.status).toBe("needs_review");
    expect(it?.classification).toBe("pdf");
  });

  test("INB-007 EC-INB-21 a mail without attachment gets a readable PDF rendition carrying the headers; classified as „other“", async () => {
    const t = makeT();
    const owner = await setup(t);
    await enableInbox(owner);
    putR2(
      "inbox/2-text.eml",
      eml({ from: "Hotel <buchung@hotel.de>", subject: "Ihre Buchung", text: "Rechnung folgt per Link." }),
    );
    await poll(t);
    await settleInbox(t);
    const [it] = await items(t);
    expect(it?.flags).toContain("no_attachment");
    expect(it?.mailRendition?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(it?.classification).toBe("other");
    expect(codes(it as never)).toEqual(expect.arrayContaining(["mail_no_attachment", "manual"]));
    const v = await voucherOf(t, it?.voucherId as Id<"vouchers">);
    expect(v.renditions).toEqual([expect.objectContaining({ kind: "html_pdf", ofFileIndex: 0 })]);
  });
});

describe("hybrid PDFs and XML (INB-021…024, EC-INB-03/04/13/14/15)", () => {
  test("EC-INB-03 T06-028 an encrypted PDF is stored as original, not extracted and not sent to OCR", async () => {
    const t = makeT();
    const owner = await setup(t);
    await enableOcr(owner);
    claudeFake.enabled = true;
    const bytes = enc("%PDF-1.4\n1 0 obj <</Type /Page>> endobj\ntrailer\n<< /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF\n");
    const r = await ingest(t, owner, [{ bytes, name: "geschuetzt.pdf" }]);
    await settleInbox(t);
    const it = await item(t, r.id);
    expect(it.flags).toContain("pdf_encrypted");
    expect(it.warnings?.find((w) => w.code === "pdf_encrypted")?.message).toBe(
      "Die PDF ist passwortgeschützt und kann nicht ausgelesen werden. Bitte Daten manuell erfassen.",
    );
    expect(codes(it)).toContain("manual");
    expect(claudeFake.calls).toBe(0);
    expect(it.files).toHaveLength(1);
    expect(it.classification).toBe("pdf");
  });

  test("EC-INB-14 T06-029 two embedded XMLs: factur-x.xml is used and the others are listed", async () => {
    const t = makeT();
    const owner = await setup(t);
    await asBuyer(t);
    passing();
    const pdf = await hybridPdf([
      { name: "factur-x.xml", xml: CII_BASIC_WL },
      {
        name: "xrechnung.xml",
        xml: CII_BASIC_WL.replace("</rsm:CrossIndustryInvoice>", "<!-- 2 --></rsm:CrossIndustryInvoice>"),
      },
    ]);
    const r = await ingest(t, owner, [{ bytes: pdf, name: "rechnung.pdf" }]);
    await settleInbox(t);
    const it = await item(t, r.id);
    expect(it.classification).toBe("zugferd");
    expect(it.files[1]?.name).toBe("factur-x.xml");
    expect(it.warnings?.find((w) => w.code === "einvoice_multiple_xml")?.message).toBe(
      "Mehrere eingebettete Rechnungs-XML gefunden. Verwendet: factur-x.xml.",
    );
  });

  test("EC-INB-15 T06-030a PDF text and XML disagree on the gross amount → listed; the XML values are booked", async () => {
    const t = makeT();
    const owner = await setup(t);
    await asBuyer(t);
    passing();
    const pdf = await hybridPdf([{ name: "factur-x.xml", xml: ciiXml() }], ["Rechnung", "Gesamtbetrag: 999,00 EUR"]);
    const r = await ingest(t, owner, [{ bytes: pdf, name: "rechnung.pdf" }]);
    await settleInbox(t);
    const it = await item(t, r.id);
    const w = it.warnings?.find((x) => x.code === "einvoice_pdf_mismatch");
    expect(w?.message).toBe(
      "PDF-Darstellung und XML weichen ab (Bruttobetrag). Maßgeblich ist die XML; bitte ggf. Korrektur beim Lieferanten anfordern.",
    );
    const v = await voucherOf(t, it.voucherId as Id<"vouchers">);
    expect(v.statedTotals?.grossCents).toBe(119_000);
  });

  test("EC-INB-13 INB-024 a hybrid whose validation was retried is validated from the stored PDF on the next run", async () => {
    const t = makeT();
    const owner = await setup(t);
    await asBuyer(t);
    const pdf = await hybridPdf([{ name: "factur-x.xml", xml: CII_BASIC_WL }]);
    const r = await ingest(t, owner, [{ bytes: pdf, name: "rechnung.pdf" }]);
    await settleInbox(t);
    const waiting = await item(t, r.id);
    expect(waiting.status).toBe("processing");
    expect(waiting.files.map((f) => f.role)).toEqual(["original", "extracted_xml"]);
    passing();
    await runRetry(t, r.id);
    const done = await item(t, r.id);
    expect(done.status).toBe("needs_review");
    // Both runs validated the parent PDF (Mustang), never the XML alone: the second found the XML on the item.
    expect(inboundValidatorFake.calls).toEqual({ xml: 0, pdf: 2 });
    expect(done.files).toHaveLength(2);
    expect(done.classification).toBe("zugferd");
  });

  test("EC-INB-13 after 24 h without the sidecar the draft is created „nicht geprüft“ (never valid)", async () => {
    const t = makeT();
    const owner = await setup(t);
    await asBuyer(t);
    const r = await ingest(t, owner, [{ bytes: enc(ciiXml()), name: "rechnung.xml" }]);
    await settleInbox(t);
    expect((await item(t, r.id)).status).toBe("processing");
    // 25 hours later (capturedAt is frozen, so the clock moves).
    const later = Date.now() + 25 * 3_600_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      await t.action(internal.inboxNode.classify, { id: r.id, actorContext: OWNER });
    } finally {
      spy.mockRestore();
    }
    await settleInbox(t);
    const it = await item(t, r.id);
    expect(it.status).toBe("needs_review");
    expect(it.einvoice?.validation).toMatchObject({ acceptable: false, tool: "none", unavailable: true });
    expect(it.warnings?.find((w) => w.code === "einvoice_not_validated")).toMatchObject({
      acknowledge: true,
      message:
        "E-Rechnungsprüfung war 24 Stunden lang nicht möglich. Die Rechnung gilt nicht als geprüft – bitte später erneut prüfen lassen.",
    });
    expect(codes(it)).not.toContain("einvoice_sidecar_unavailable");
    const d = await owner.query(api.inbox.get, { id: r.id });
    expect(d?.einvoice?.validation).toMatchObject({ unavailable: true, reportUrl: null, reportSha256: null });
    expect(d?.einvoiceOk).toBe(false);
  });

  test("EC-INB-04 a broken CII is a Formatfehler with syntax cii; an XML that is no invoice gets no E-Rechnung data", async () => {
    const t = makeT();
    const owner = await setup(t);
    const broken = `<?xml version="1.0"?><rsm:CrossIndustryInvoice xmlns:rsm="urn:x"><unclosed></rsm:CrossIndustryInvoice>`;
    const a = await ingest(t, owner, [{ bytes: enc(broken), name: "kaputt.xml" }]);
    const b = await ingest(t, owner, [
      { bytes: enc(`<?xml version="1.0"?><note><to>x</to></note>`), name: "notiz.xml" },
    ]);
    await settleInbox(t);
    const ia = await item(t, a.id);
    expect(ia.flags).toContain("einvoice_format_error");
    expect(ia.einvoice).toMatchObject({ syntax: "cii", profile: "UNKNOWN", notEInvoice: true });
    expect(ia.einvoice?.validation).toMatchObject({ acceptable: false, category: "format", tool: "parser" });
    const ib = await item(t, b.id);
    expect(ib.flags).toContain("einvoice_format_error");
    expect(ib.einvoice).toBeUndefined();
    expect(ib.classification).toBe("xrechnung");
    expect(codes(ib)).toEqual(expect.arrayContaining(["einvoice_format_error", "einvoice_faulty"]));
  });

  test("INB-028 a file whose blob is missing makes the classification fail loudly (no silent draft)", async () => {
    const t = makeT();
    const owner = await setup(t);
    const r = await ingest(t, owner, [{ bytes: enc(ciiXml()), name: "rechnung.xml" }]);
    await settleInbox(t);
    const it = await item(t, r.id);
    await t.run((ctx) => ctx.storage.delete(it.files[0]?.storageId as Id<"_storage">));
    await expect(t.action(internal.inboxNode.classify, { id: r.id, actorContext: OWNER })).rejects.toThrow(
      "Datei nicht gefunden",
    );
    expect((await item(t, r.id)).voucherId).toBeUndefined();
  });
});

describe("OCR (INB-025…027, SET-111, EC-INB-16)", () => {
  test("INB-025 the monthly budget stops further OCR calls: the next receipt is captured manually", async () => {
    const t = makeT();
    const owner = await setup(t);
    await enableOcr(owner, { monthlyBudget: 1, endpoint: "https://claude-proxy.example.de" });
    claudeFake.enabled = true;
    const first = await ingest(t, owner, [{ bytes: await plainPdf(["Beleg A"]), name: "a.pdf" }]);
    await settleInbox(t);
    expect((await item(t, first.id)).confidence).toBeGreaterThan(0);
    const second = await ingest(t, owner, [{ bytes: await plainPdf(["Beleg B"]), name: "b.pdf" }]);
    await settleInbox(t);
    expect(claudeFake.calls).toBe(1);
    const it = await item(t, second.id);
    expect(it.warnings?.find((w) => w.code === "ocr_budget")?.message).toBe(
      "Monatsbudget der Belegerkennung erreicht – bitte manuell erfassen.",
    );
    expect(codes(it)).toContain("manual");
  });

  test("INB-026 an image is sent to OCR; a supplier with a tax number but no VAT ID counts as domestic; a supply period is kept", async () => {
    const t = makeT();
    const owner = await setup(t);
    await enableOcr(owner);
    claudeFake.enabled = true;
    const x = JSON.parse(JSON.stringify(CLAUDE_FAKE_EXTRACTION)) as Record<string, unknown> & {
      supplier: Record<string, unknown>;
    };
    x.supplier.vatId = null;
    x.supplier.taxNumber = "12/345/67890";
    x.supplyPeriod = { from: "2026-09-01", to: "2026-09-30" };
    x.categoryHint = null;
    claudeFake.respond = () => claudeFakeMessage(x);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
    const r = await ingest(t, owner, [{ bytes: jpeg, name: "foto.jpg" }]);
    await settleInbox(t);
    expect(claudeFake.calls).toBe(1);
    const it = await item(t, r.id);
    expect(it.classification).toBe("image");
    const v = await voucherOf(t, it.voucherId as Id<"vouchers">);
    expect(v.supplyDate).toEqual({ kind: "period", from: "2026-09-01", to: "2026-09-30" });
    expect(v.supplierName).toBe("Telekom Deutschland GmbH");
  });

  test("INB-027 a temporarily unreachable OCR is retried twice, then the receipt goes to manual capture", async () => {
    const t = makeT();
    const owner = await setup(t);
    await enableOcr(owner);
    claudeFake.enabled = true;
    claudeFake.respond = () => ({
      status: 503,
      body: { type: "error", error: { type: "overloaded_error", message: "busy" } },
    });
    const r = await ingest(t, owner, [{ bytes: await plainPdf(["Beleg C"]), name: "c.pdf" }]);
    await settleInbox(t);
    const waiting = await item(t, r.id);
    expect(waiting.status).toBe("processing");
    expect(waiting.warnings?.find((w) => w.code === "ocr_retry")?.message).toBe(
      "Belegerkennung vorübergehend nicht erreichbar – wird wiederholt.",
    );
    expect(waiting.nextAttemptAt).toBeGreaterThan(Date.now());
    await runRetry(t, r.id);
    expect((await item(t, r.id)).status).toBe("processing");
    await runRetry(t, r.id);
    const it = await item(t, r.id);
    expect(it.status).toBe("needs_review");
    expect(it.attempts).toBe(3);
    expect(it.warnings?.find((w) => w.code === "ocr_failed")?.message).toBe(
      "Die Belegerkennung hat keine Daten geliefert. Bitte manuell erfassen.",
    );
    expect(claudeFake.calls).toBe(3);
  });

  test("INB-027 a refusal is not retried: manual capture at once", async () => {
    const t = makeT();
    const owner = await setup(t);
    await enableOcr(owner);
    claudeFake.enabled = true;
    claudeFake.respond = () => claudeFakeMessage("", { stopReason: "refusal" });
    const r = await ingest(t, owner, [{ bytes: await plainPdf(["Beleg D"]), name: "d.pdf" }]);
    await settleInbox(t);
    const it = await item(t, r.id);
    expect(it.attempts).toBe(1);
    expect(codes(it)).toEqual(expect.arrayContaining(["ocr_failed", "manual"]));
    expect(it.flags ?? []).not.toContain("ocr_pending");
  });

  test("SET-112 „Verbindung testen“ without a key and with a rejected key reports the failure", async () => {
    const t = makeT();
    const owner = await setup(t);
    expect(await owner.action(api.inboxNode.testClaude, {})).toEqual({
      ok: false,
      detail: "Kein API-Schlüssel hinterlegt.",
    });
    await enableOcr(owner);
    claudeFake.enabled = true;
    claudeFake.respond = () => ({
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
    });
    const r = await owner.action(api.inboxNode.testClaude, {});
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("401");
    const s = await owner.query(api.inbox.settings, {});
    expect(s.ocr.lastTestOk).toBe(false);
    expect(s.ocr.lastTestDetail).toBe(r.detail);
  });
});

describe("R2 poll and connection test (INB-049, INB-052, EC-INB-27/29/32)", () => {
  test("INB-052 a poll without credentials or after a 500 on LIST is reported; foreign objects are ignored", async () => {
    const t = makeT();
    const owner = await setup(t);
    await enableInbox(owner);
    delete process.env.R2_INBOX_FAKE;
    expect(await poll(t)).toEqual({ imported: 0, deleted: 0, failed: 0, skipped: "not_configured" });
    process.env.R2_INBOX_FAKE = "true";
    expect(await t.action(internal.inboxNode.pollR2, {})).toMatchObject({ skipped: "test" });
    memoryInbox.listStatus = 500;
    expect(await poll(t)).toEqual({ imported: 0, deleted: 0, failed: 1 });
    let s = await owner.query(api.inbox.settings, {});
    // A plain failure is no pause (only 401/403/404 pause, EC-INB-29).
    expect(s.inbox.health.pausedAt).toBeUndefined();
    expect(s.inbox.health.lastError).toBe("HTTP 500");
    memoryInbox.listStatus = null;
    putR2("inbox/notiz.txt", enc("keine Mail"));
    putR2("inbox/1-a.eml", eml({ text: "a" }));
    expect(await poll(t)).toMatchObject({ imported: 1, deleted: 1, failed: 0 });
    expect(memoryInbox.objects.has("inbox/notiz.txt")).toBe(true);
    s = await owner.query(api.inbox.settings, {});
    expect(s.inbox.health.objectsWaiting).toBe(0);
    await settleInbox(t);
  });

  test("SET-110 EC-INB-29 the connection test: a 500 does not pause, a 403 pauses the poll", async () => {
    const t = makeT();
    const owner = await setup(t);
    await enableInbox(owner);
    memoryInbox.listStatus = 500;
    expect(await owner.action(api.inboxNode.testR2, {})).toEqual({ ok: false, detail: "Bucket test-inbox: HTTP 500" });
    expect((await t.query(internal.inbox.pollState, {})).paused).toBe(false);
    memoryInbox.listStatus = 403;
    expect(await owner.action(api.inboxNode.testR2, {})).toEqual({ ok: false, detail: "Bucket test-inbox: HTTP 403" });
    expect((await t.query(internal.inbox.pollState, {})).paused).toBe(true);
    memoryInbox.listStatus = null;
    const ok = await owner.action(api.inboxNode.testR2, {});
    expect(ok).toEqual({ ok: true, detail: "Bucket test-inbox: 0 Nachricht(en) warten", objects: 0, oldest: null });
    expect((await t.query(internal.inbox.pollState, {})).paused).toBe(false);
  });

  test("INB-046 no correction letter for a plain upload without findings", async () => {
    const t = makeT();
    const owner = await setup(t);
    const r = await ingest(t, owner, [{ bytes: pdfBytes("kein-befund"), name: "a.pdf" }]);
    await settleInbox(t);
    const e = await errorOf(owner.action(api.inboxNode.exportCorrectionLetter, { id: r.id }));
    expect(e).toMatchObject({
      code: "invalid_input",
      message: "Für diesen Beleg liegt kein Prüfbefund vor – eine Korrekturanforderung ist nicht nötig.",
    });
  });
});
