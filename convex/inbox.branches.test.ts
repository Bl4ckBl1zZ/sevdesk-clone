import { describe, expect, test } from "vitest";
import { sha256Hex } from "../src/domain/audit/chain";
import { supplierKeys } from "../src/domain/vouchers/supplier-key";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { enableInbox, enableOcr, enc, ingest, installInboxFakes, item, settleInbox, voucherOf } from "./inbox.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert, auditedPatch } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import {
  appendInboxFiles,
  finishClassification,
  type NewInboxFile,
  recordMailParse,
  rejectInboxItem,
  scheduleClassifyRetry,
  storeInboxItem,
} from "./model/inbox";
import { makeT, type TestT } from "./test.setup";
import { header, OWNER, pdfBytes, setupCompany, TODAY, upload } from "./vouchers.fixtures";

/**
 * F06 inbox branches (convex/inbox.ts, convex/model/inbox.ts): list/detail fallbacks, capture guards, duplicate
 * detection against items and vouchers, mail parse, split/merge, reject/override guards, supplier matching and the
 * internal pipeline mutations.
 */

installInboxFakes();

type Owner = Awaited<ReturnType<TestT["asUser"]>>;

async function errorOf(p: Promise<unknown>): Promise<{ code: string; message: string; data: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    const data = ((e as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
    return { code: errorCode(e) ?? "unknown", message: String(data.message ?? (e as Error).message), data };
  }
  throw new Error("expected an error");
}

async function setup(t: TestT): Promise<Owner> {
  await setupCompany(t);
  return t.asUser("owner");
}

/** Stores the bytes and returns a file entry as the capture actions pass it to the model. */
async function newFile(
  t: TestT,
  bytes: Uint8Array,
  name: string,
  mime = "application/pdf",
  extra: Partial<NewInboxFile> = {},
): Promise<NewInboxFile> {
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([bytes as BlobPart], { type: mime })));
  return { storageId, sha256: await sha256Hex(bytes), name, mime, bytes: bytes.byteLength, ...extra };
}

/** An item stored directly through the model without scheduling the classification (keeps it `new`). */
function store(t: TestT, args: Omit<Parameters<typeof storeInboxItem>[1], "schedule">) {
  return t.model(OWNER, (ctx) => storeInboxItem(ctx, { ...args, schedule: false }));
}

const accountsOf = (t: TestT, voucherId: Id<"vouchers">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("voucherLines").collect())
      .filter((l) => l.voucherId === voucherId)
      .sort((a, b) => a.position - b.position)
      .map((l) => l.account),
  );

const audit = (t: TestT, action: string) =>
  t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).filter((a) => a.action === action));

describe("list, counts and detail (F06 §6.1, INB-001)", () => {
  test("INB-001 the list filters by chip, source and classification; an unknown chip shows all; the limit caps", async () => {
    const t = makeT();
    const owner = await setup(t);
    const up = await ingest(t, owner, [{ bytes: pdfBytes("list-a"), name: "Quittung.pdf" }]);
    await settleInbox(t);
    const mail = await store(t, {
      source: "email",
      files: [await newFile(t, enc("From: a@b.de\r\n\r\nHallo"), "1-a.eml", "message/rfc822")],
      from: "Rechnung  <rechnung@lieferant.de>",
      to: "belege@in.example.de",
      subject: "  Ihre   Rechnung  ",
      messageId: "<m-1@lieferant.de>",
    });
    expect(mail.status).toBe("new");
    const stored = await item(t, mail.id);
    // INB-050: header values are normalised (whitespace collapsed, angle brackets dropped) and the role is `eml`.
    expect(stored).toMatchObject({
      from: "Rechnung <rechnung@lieferant.de>",
      subject: "Ihre Rechnung",
      messageId: "m-1@lieferant.de",
    });
    expect(stored.files[0]?.role).toBe("eml");

    expect((await owner.query(api.inbox.list, { filter: "unbekannt" })).map((r) => r.id).sort()).toEqual(
      [up.id, mail.id].sort(),
    );
    const [fresh] = await owner.query(api.inbox.list, { filter: "new" });
    expect(fresh).toMatchObject({
      id: mail.id,
      statusLabel: "Neu",
      from: "Rechnung <rechnung@lieferant.de>",
      subject: "Ihre Rechnung",
      fileName: "1-a.eml",
      classification: null,
      einvoiceOk: null,
      voucherId: null,
      supplierName: null,
      grossCents: null,
      currency: null,
      flags: [],
    });
    const uploads = await owner.query(api.inbox.list, { source: "upload" });
    expect(uploads.map((r) => r.id)).toEqual([up.id]);
    expect(uploads[0]).toMatchObject({ statusLabel: "Zu prüfen", classification: "pdf", currency: "EUR" });
    expect((await owner.query(api.inbox.list, { classification: "pdf" })).map((r) => r.id)).toEqual([up.id]);
    expect(await owner.query(api.inbox.list, { limit: 1 })).toHaveLength(1);
    expect(await owner.query(api.inbox.counts, {})).toMatchObject({ all: 2, new: 1, needs_review: 1, duplicate: 0 });
  });

  test("INB-001 the detail of an unknown item is null; an unprocessed item shows empty defaults", async () => {
    const t = makeT();
    const owner = await setup(t);
    const r = await store(t, {
      source: "api",
      files: [await newFile(t, pdfBytes("detail"), "beleg.pdf")],
      note: "  Tankquittung   vom Wochenende ",
    });
    const d = await owner.query(api.inbox.get, { id: r.id });
    expect(d).toMatchObject({
      source: "api",
      status: "new",
      voucherStatus: null,
      visualisationUrl: null,
      mailRenditionUrl: null,
      to: null,
      messageId: null,
      note: "Tankquittung vom Wochenende",
      einvoice: null,
      supplierMatch: null,
      supplierProposal: null,
      createdFrom: null,
      supersededBy: null,
      rejectText: null,
      retentionUntil: null,
      skippedAttachments: [],
      warnings: [],
      nextAttemptAt: null,
    });
    expect(d?.files[0]).toMatchObject({ index: 0, pages: null, derivedFrom: null, clientCapturedAt: null });
    expect(d?.files[0]?.url).toMatch(/^https?:/);
    const gone = await t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = (await ctx.db.get(r.id)) as Doc<"inboxItems">;
      const id = await ctx.db.insert("inboxItems", rest);
      await ctx.db.delete(id);
      return id;
    });
    expect(await owner.query(api.inbox.get, { id: gone })).toBeNull();
  });
});

describe("capture guards (INB-001, INB-008, INB-020)", () => {
  test("INB-001 an empty call, a missing upload and a blank file name are handled; the note and source are kept", async () => {
    const t = makeT();
    const owner = await setup(t);
    expect((await errorOf(owner.action(api.inbox.ingest, { files: [] }))).message).toBe(
      "Bitte 1 bis 100 Dateien hochladen.",
    );
    const sid = await t.run((ctx) => ctx.storage.store(new Blob([pdfBytes("weg") as BlobPart])));
    await t.run((ctx) => ctx.storage.delete(sid));
    const missing = await errorOf(owner.action(api.inbox.ingest, { files: [{ storageId: sid, name: "x.pdf" }] }));
    expect(missing).toMatchObject({ code: "not_found", message: "Die hochgeladene Datei wurde nicht gefunden." });

    const sid2 = await t.run((ctx) => ctx.storage.store(new Blob([pdfBytes("blank") as BlobPart])));
    const r = await owner.action(api.inbox.ingest, {
      files: [{ storageId: sid2, name: "   " }],
      note: "Beleg aus dem Handschuhfach",
    });
    await settleInbox(t);
    const it = await item(t, r.id);
    expect(it.files[0]?.name).toBe("beleg");
    expect(it.note).toBe("Beleg aus dem Handschuhfach");
    expect(it.source).toBe("upload");
  });

  test("INB-008 SEC-06 REST/MCP base64: empty, invalid base64; the channel decides the source; the note is kept", async () => {
    const t = makeT();
    await setup(t);
    const key = await t.asApiKey(["vouchers:write", "vouchers:read"]);
    expect((await errorOf(key.action(api.inbox.ingestBase64, { files: [] }))).message).toBe(
      "Bitte 1 bis 100 Dateien hochladen.",
    );
    const bad = await errorOf(
      key.action(api.inbox.ingestBase64, { files: [{ filename: "x.pdf", contentBase64: "%%%nicht base64%%%" }] }),
    );
    expect(bad).toMatchObject({ code: "invalid_input", message: "content_base64 ist kein gültiges Base64." });
    expect(await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length)).toBe(0);

    const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
    const viaKey = await key.action(api.inbox.ingestBase64, {
      files: [{ filename: "api.pdf", contentBase64: `data:application/pdf;base64,${b64(pdfBytes("b64-api"))}` }],
      note: "per REST",
      via: "app",
    });
    const mcp = await t.asMcp(["vouchers:write", "vouchers:read"]);
    const viaMcp = await mcp.action(api.inbox.ingestBase64, {
      files: [{ filename: "mcp.pdf", contentBase64: b64(pdfBytes("b64-mcp")) }],
    });
    await settleInbox(t);
    // INB-004: only a signed-in UI session may record `app`; an API key stays `api`.
    expect(await item(t, viaKey.id)).toMatchObject({ source: "api", note: "per REST" });
    expect((await item(t, viaMcp.id)).source).toBe("mcp");
    // The ingest action called with an API key records `api` too.
    const sid = await t.run((ctx) => ctx.storage.store(new Blob([pdfBytes("ingest-api") as BlobPart])));
    const viaIngest = await key.action(api.inbox.ingest, { files: [{ storageId: sid, name: "i.pdf" }] });
    await settleInbox(t);
    expect((await item(t, viaIngest.id)).source).toBe("api");
  });

  test("INB-020 the model refuses a capture without files; an image file keeps its quality data and role", async () => {
    const t = makeT();
    await setup(t);
    expect((await errorOf(store(t, { source: "upload", files: [] }))).message).toBe(
      "Bitte mindestens eine Datei hochladen.",
    );
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 1, 2, 3]);
    const r = await store(t, {
      source: "app",
      files: [
        await newFile(t, jpeg, "foto.jpg", "image/jpeg", {
          pages: 1,
          clientCapturedAt: 1_700_000_000_000,
          image: { width: 800, height: 1200, estimatedDpi: 150, low: false },
        }),
      ],
      clientCapturedAt: 1_700_000_000_000,
    });
    const it = await item(t, r.id);
    expect(it.files[0]).toMatchObject({
      role: "original",
      capturedVia: "app",
      pages: 1,
      clientCapturedAt: 1_700_000_000_000,
    });
    expect(it.files[0]?.image).toBeDefined();
    expect(it.clientCapturedAt).toBe(1_700_000_000_000);
  });
});

describe("duplicates (VOU-050, EC-160)", () => {
  test("VOU-050 a file identical to a voucher original is a duplicate of the voucher; a cancelled voucher no longer counts", async () => {
    const t = makeT();
    const owner = await setup(t);
    const bytes = pdfBytes("dup-voucher");
    const { voucherId } = await upload(t, owner, { bytes });
    const dup = await store(t, { source: "upload", files: [await newFile(t, bytes, "nochmal.pdf")] });
    expect(dup.status).toBe("duplicate");
    const it = await item(t, dup.id);
    expect(it.duplicateOfVoucherId).toBe(voucherId);
    expect(it.duplicateOfInboxItemId).toBeUndefined();
    expect(it.warnings?.[0]?.message).toMatch(/^Diese Datei wurde bereits erfasst \(.+\)\.$/);

    // A booked and then cancelled voucher is no duplicate source any more.
    const bytes2 = pdfBytes("dup-cancelled");
    const second = await upload(t, owner, { bytes: bytes2 });
    await owner.mutation(api.vouchers.updateDraft, { id: second.voucherId, input: header() });
    await owner.mutation(api.vouchers.finalize, { id: second.voucherId });
    await owner.mutation(api.vouchers.cancel, { id: second.voucherId, reason: "Falsch erfasst, Storno" });
    expect((await voucherOf(t, second.voucherId)).status).toBe("cancelled");
    const fresh = await store(t, { source: "upload", files: [await newFile(t, bytes2, "storniert.pdf")] });
    expect(fresh.status).toBe("new");
  });

  test("VOU-050 „Trotzdem verarbeiten“ only for duplicates and with a reason of at least 5 characters", async () => {
    const t = makeT();
    const owner = await setup(t);
    const bytes = pdfBytes("override");
    const first = await store(t, { source: "upload", files: [await newFile(t, bytes, "a.pdf")] });
    const dup = await store(t, { source: "upload", files: [await newFile(t, bytes, "b.pdf")] });
    expect(
      (await errorOf(owner.mutation(api.inbox.overrideDuplicate, { id: first.id, reason: "egal warum" }))).message,
    ).toBe("Der Beleg ist nicht als Dublette markiert.");
    expect((await errorOf(owner.mutation(api.inbox.overrideDuplicate, { id: dup.id, reason: " ok " }))).message).toBe(
      "Bitte angeben, warum die Dublette trotzdem verarbeitet wird (mindestens 5 Zeichen).",
    );
    await owner.mutation(api.inbox.overrideDuplicate, { id: dup.id, reason: "Zweite Seite, eigener Beleg" });
    await settleInbox(t);
    const it = await item(t, dup.id);
    expect(it.duplicateOverride?.reason).toBe("Zweite Seite, eigener Beleg");
    expect(it.status).toBe("needs_review");
    expect((await audit(t, "inbox.duplicate_override"))[0]?.reason).toBe("Zweite Seite, eigener Beleg");
  });
});

describe("mail parse and pipeline mutations (INB-050, INB-041, EC-INB-13, EC-INB-24)", () => {
  test("INB-050 VOU-050 an attachment identical to a voucher original turns the mail into a duplicate; a second parse is a no-op", async () => {
    const t = makeT();
    const owner = await setup(t);
    const pdf = pdfBytes("mail-att");
    const { voucherId } = await upload(t, owner, { bytes: pdf });
    const mail = await store(t, {
      source: "email",
      files: [await newFile(t, enc("raw mail"), "m.eml", "message/rfc822")],
    });
    const rendition = await newFile(t, pdfBytes("rendition"), "mail.pdf");
    const args = {
      id: mail.id,
      from: "rechnung@lieferant.de",
      to: "belege@in.example.de",
      subject: "Rechnung\n  Oktober",
      messageId: "<neu@lieferant.de>",
      mailText: "Anbei die Rechnung.",
      files: [await newFile(t, pdf, "rechnung.pdf", "application/pdf", { role: "original", derivedFrom: 0, pages: 1 })],
      mailRendition: { storageId: rendition.storageId, sha256: rendition.sha256 },
      skipped: [{ name: "video.mp4", mime: "video/mp4", bytes: 30_000_000, reason: "too_large" as const }],
      flags: ["attachment_too_large"],
      warnings: [{ code: "attachment_too_large", message: "zu groß" }],
      duplicateMessage: (d: string) => `Diese E-Mail wurde bereits am ${d} empfangen.`,
    };
    expect(await t.model(OWNER, (ctx) => recordMailParse(ctx, args))).toEqual({ duplicate: true });
    const it = await item(t, mail.id);
    expect(it).toMatchObject({
      status: "duplicate",
      duplicateOfVoucherId: voucherId,
      mailParsed: true,
      subject: "Rechnung Oktober",
      messageId: "neu@lieferant.de",
      mailText: "Anbei die Rechnung.",
      flags: ["attachment_too_large"],
    });
    expect(it.skippedAttachments).toHaveLength(1);
    expect(it.mailRendition?.sha256).toBe(rendition.sha256);
    expect(it.warnings?.map((w) => w.code)).toEqual(["attachment_too_large", "duplicate_file"]);
    // Idempotent: the second run changes nothing and reports the stored state.
    expect(await t.model(OWNER, (ctx) => recordMailParse(ctx, args))).toEqual({ duplicate: true });
    expect((await item(t, mail.id)).files).toHaveLength(2);

    // An attachment identical to another inbox item → duplicate of that item.
    const other = pdfBytes("mail-att-2");
    const first = await store(t, { source: "upload", files: [await newFile(t, other, "erst.pdf")] });
    const mail2 = await store(t, {
      source: "email",
      files: [await newFile(t, enc("raw 2"), "n.eml", "message/rfc822")],
    });
    const copy = await newFile(t, other, "kopie.pdf", "application/pdf", { role: "original", derivedFrom: 0 });
    const r2 = await t.model(OWNER, (ctx) =>
      recordMailParse(ctx, {
        id: mail2.id,
        files: [copy],
        skipped: [],
        flags: [],
        warnings: [],
        duplicateMessage: (d) => d,
      }),
    );
    expect(r2.duplicate).toBe(true);
    expect(await item(t, mail2.id)).toMatchObject({ status: "duplicate", duplicateOfInboxItemId: first.id });
  });
});

describe("pipeline mutations (INB-041, EC-INB-13, INB-028)", () => {
  test("INB-041 appending files that are already on the item adds nothing and points at the existing index", async () => {
    const t = makeT();
    await setup(t);
    const bytes = pdfBytes("append");
    const r = await store(t, { source: "upload", files: [await newFile(t, bytes, "a.pdf")] });
    const same = await newFile(t, bytes, "a.pdf");
    expect(await t.model(OWNER, (ctx) => appendInboxFiles(ctx, r.id, [same]))).toEqual({ firstIndex: 0 });
    expect(await t.model(OWNER, (ctx) => appendInboxFiles(ctx, r.id, []))).toEqual({ firstIndex: 1 });
    expect((await item(t, r.id)).files).toHaveLength(1);
    expect(await audit(t, "inbox.files_extracted")).toHaveLength(0);
  });

  test("EC-INB-13 a retry is only scheduled while the item is processing; classify skips an item that is not new", async () => {
    const t = makeT();
    const owner = await setup(t);
    const r = await store(t, { source: "upload", files: [await newFile(t, pdfBytes("retry"), "a.pdf")] });
    await t.model(OWNER, (ctx) =>
      scheduleClassifyRetry(ctx, { id: r.id, delayMs: 60_000, warning: { code: "x", message: "später" } }),
    );
    const it = await item(t, r.id);
    expect(it.nextAttemptAt).toBeUndefined();
    expect(await audit(t, "inbox.classify_retry")).toHaveLength(0);
    // A rejected item is never classified again (beginClassification → proceed: false).
    await owner.mutation(api.inbox.reject, { id: r.id, reason: "no_business_document" });
    await t.action(internal.inboxNode.classify, { id: r.id, actorContext: OWNER });
    const after = await item(t, r.id);
    expect(after).toMatchObject({ status: "rejected", attempts: 0 });
    expect(after.voucherId).toBeUndefined();
  });

  test("INB-028 finishing is idempotent; a rejected item gets no draft; einvoice defaults to „Formatfehler, nicht geprüft“", async () => {
    const t = makeT();
    await setup(t);
    const xml = await newFile(t, enc("<Invoice/>"), "r.xml", "application/xml");
    const r = await store(t, { source: "upload", files: [xml] });
    const first = await t.mutation(internal.inbox.finishInternal, {
      actorContext: OWNER,
      id: r.id,
      classification: "xrechnung",
      input: { direction: "expense" },
      einvoice: { syntax: "ubl", profile: "XRECHNUNG", notEInvoice: false, xmlFileIndex: 0 },
      warnings: [
        { code: "w1", message: "Hinweis" },
        { code: "w1", message: "Hinweis doppelt" },
      ],
      confidence: 0.4,
    });
    expect(first.voucherId).toBeTruthy();
    const it = await item(t, r.id);
    expect(it.warnings?.filter((w) => w.code === "w1")).toHaveLength(1);
    expect(it).toMatchObject({ status: "needs_review", einvoiceProfile: "XRECHNUNG", confidence: 0.4 });
    const v = await voucherOf(t, first.voucherId as Id<"vouchers">);
    expect(v.einvoice?.validation).toMatchObject({ acceptable: false, category: "format", tool: "none", findings: [] });
    expect(v.einvoice?.xmlSha256).toBe(xml.sha256);
    // Idempotent: the same draft again.
    const again = await t.mutation(internal.inbox.finishInternal, {
      actorContext: OWNER,
      id: r.id,
      classification: "pdf",
      input: { direction: "expense" },
    });
    expect(again.voucherId).toBe(first.voucherId);

    const rej = await store(t, { source: "upload", files: [await newFile(t, pdfBytes("rej"), "r.pdf")] });
    await t.model(OWNER, (ctx) =>
      rejectInboxItem(ctx, { id: rej.id, reason: "other", text: "Privatbeleg, falsch hochgeladen" }),
    );
    const none = await t.model(OWNER, (ctx) =>
      finishClassification(ctx, rej.id, { classification: "pdf", input: { direction: "expense" } }),
    );
    expect(none.voucherId).toBeNull();
    const rejected = await item(t, rej.id);
    expect(rejected.rejectText).toBe("Privatbeleg, falsch hochgeladen");
    expect((await audit(t, "inbox.reject"))[0]?.reason).toBe("Privatbeleg, falsch hochgeladen");
  });

  test("SET-113 the OCR pending flag is cleared without counting a call; classifyInput carries the company facts", async () => {
    const t = makeT();
    const owner = await setup(t);
    await enableOcr(owner);
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(
        ctx,
        { tradeName: "Muster Studio", vatId: "DE811907980" },
        { action: "settings.company.update" },
      ),
    );
    const r = await store(t, { source: "upload", files: [await newFile(t, pdfBytes("pending"), "a.pdf")] });
    await t.mutation(internal.inbox.ocrPendingInternal, { actorContext: OWNER, id: r.id, pending: true });
    expect((await item(t, r.id)).flags).toEqual(["ocr_pending"]);
    await t.mutation(internal.inbox.ocrPendingInternal, { actorContext: OWNER, id: r.id, pending: false });
    expect((await item(t, r.id)).flags).toEqual([]);
    const input = await t.query(internal.inbox.classifyInput, { id: r.id });
    expect(input?.company).toMatchObject({
      name: "Muster Design",
      tradeName: "Muster Studio",
      vatId: "DE811907980",
      ku: false,
    });
    expect(input?.ocr.active).toBe(true);
    expect(input?.ocr.encryptedSecrets).toBeTruthy();
    expect(input?.allowlist).toEqual([]);
    // Only the one `pending: true` call counts for the monthly budget.
    const claude = await t.run((ctx) =>
      ctx.db
        .query("integrations")
        .withIndex("by_kind", (q) => q.eq("kind", "claude"))
        .first(),
    );
    expect((claude?.config as { usage?: { calls: number } } | undefined)?.usage?.calls).toBe(1);
  });

  test("INB-020 classifyInput without a company profile has company null; an unknown item is null", async () => {
    const t = makeT();
    const r = await store(t, { source: "upload", files: [await newFile(t, pdfBytes("noprofile"), "a.pdf")] });
    expect((await t.query(internal.inbox.classifyInput, { id: r.id }))?.company).toBeNull();
    const gone = await t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = (await ctx.db.get(r.id)) as Doc<"inboxItems">;
      const id = await ctx.db.insert("inboxItems", rest);
      await ctx.db.delete(id);
      return id;
    });
    expect(await t.query(internal.inbox.classifyInput, { id: gone })).toBeNull();
    expect(await t.query(internal.inbox.ocrTestInput, {})).toEqual({
      encryptedSecrets: null,
      endpoint: null,
      model: "claude-sonnet-5-5",
    });
  });
});

describe("supplier matching and account suggestion (INB-045, VOU-041)", () => {
  async function finish(t: TestT, r: { id: Id<"inboxItems"> }, extra: Record<string, unknown>) {
    return t.mutation(internal.inbox.finishInternal, {
      actorContext: OWNER,
      id: r.id,
      classification: "pdf",
      input: { direction: "expense" },
      ...extra,
    });
  }

  test("INB-045 IBAN before name; a merged contact is never matched; without a match a full proposal is stored", async () => {
    const t = makeT();
    const { supplier } = await setupCompany(t);
    await t.model(OWNER, (ctx) =>
      auditedPatch(ctx, "contacts", supplier, { iban: "DE02120300000000202051" }, { action: "contact.update" }),
    );
    const byIban = await store(t, { source: "upload", files: [await newFile(t, pdfBytes("iban"), "a.pdf")] });
    await finish(t, byIban, { supplier: { name: "Irgendwer", iban: "de02 1203 0000 0000 2020 51" } });
    expect((await item(t, byIban.id)).supplierMatch).toEqual({ contactId: supplier, by: "iban" });

    const byName = await store(t, { source: "upload", files: [await newFile(t, pdfBytes("name"), "b.pdf")] });
    await finish(t, byName, { supplier: { name: "Büro Schmidt GmbH", iban: "DE89370400440532013000" } });
    expect((await item(t, byName.id)).supplierMatch).toEqual({ contactId: supplier, by: "name" });

    const other = await t.model(OWNER, async (ctx) => {
      const { _id, _creationTime, ...rest } = (await ctx.db.get(supplier)) as Doc<"contacts">;
      return auditedInsert(
        ctx,
        "contacts",
        { ...rest, number: "70001", numberNormalized: "70001", vatId: "DE123456789", mergedIntoId: supplier },
        { action: "contact.create" },
      );
    });
    expect(other).toBeTruthy();
    const merged = await store(t, { source: "upload", files: [await newFile(t, pdfBytes("merged"), "c.pdf")] });
    const facts = {
      name: "Neuer Lieferant GmbH",
      vatId: "DE123456789",
      taxNumber: "12/345/67890",
      iban: "DE75512108001245126199",
      email: "rechnung@neu.de",
      electronicAddress: { scheme: "EM", value: "rechnung@neu.de" },
      address: { line1: "Weg 1", postalCode: "10115", city: "Berlin", countryCode: "DE" },
    };
    await finish(t, merged, { supplier: facts });
    const it = await item(t, merged.id);
    expect(it.supplierMatch).toBeUndefined();
    expect(it.supplierProposal).toEqual({ ...facts, roles: ["supplier"] });
  });

  test("VOU-041 an empty line account is filled from the learned supplier profile, else from the keyword table", async () => {
    const t = makeT();
    await setupCompany(t);
    const key = supplierKeys({ vatId: "DE999999999" })[0] as string;
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "supplierProfiles",
        { key, lastAccount: "6815", uses: 3, accountStreak: 3, updatedAt: Date.now() },
        { action: "voucher.profile_learn", label: key },
      ),
    );
    const r = await store(t, { source: "upload", files: [await newFile(t, pdfBytes("acc"), "a.pdf")] });
    const line = { account: "", description: "Druckerpapier", amountCents: 1190, vatRateBp: 1900 };
    const res = await finish(t, r, {
      input: {
        direction: "expense",
        supplierName: "Papier AG",
        supplierVatId: "DE999999999",
        supplierIban: "DE75512108001245126199",
        documentDate: TODAY,
        lines: [line, { ...line, account: "6805", description: "Telefon" }],
      },
    });
    expect(await accountsOf(t, res.voucherId as Id<"vouchers">)).toEqual(["6815", "6805"]);

    const r2 = await store(t, { source: "upload", files: [await newFile(t, pdfBytes("acc2"), "b.pdf")] });
    const res2 = await finish(t, r2, {
      input: { direction: "expense", lines: [{ ...line, description: "Mobilfunk Telefon" }] },
      hintText: "Telefonrechnung",
    });
    expect((await accountsOf(t, res2.voucherId as Id<"vouchers">))[0]).toMatch(/^\d{4}$/);
  });
});

describe("reject, redraft, OCR release (INB-010, INB-027, SET-113, EC-INB-12)", () => {
  test("INB-010 EC-INB-12 „Sonstiges“ needs a text; no_business_document becomes purge-eligible after 90 days", async () => {
    const t = makeT();
    const owner = await setup(t);
    const a = await store(t, { source: "upload", files: [await newFile(t, pdfBytes("rej-a"), "a.pdf")] });
    expect((await errorOf(owner.mutation(api.inbox.reject, { id: a.id, reason: "other", text: " ab " }))).message).toBe(
      "Bitte den Grund kurz beschreiben (mindestens 5 Zeichen).",
    );
    expect((await errorOf(owner.mutation(api.inbox.reject, { id: a.id, reason: "other" }))).message).toBe(
      "Bitte den Grund kurz beschreiben (mindestens 5 Zeichen).",
    );
    await owner.mutation(api.inbox.reject, { id: a.id, reason: "no_business_document" });
    const it = await item(t, a.id);
    expect(it).toMatchObject({ status: "rejected", rejectReason: "no_business_document" });
    expect(it.purgeEligibleFrom).toBe(it.retentionUntil);
    expect(it.rejectText).toBeUndefined();
    expect((await audit(t, "inbox.reject"))[0]?.reason).toBe("no_business_document");
    const d = await owner.query(api.inbox.get, { id: a.id });
    expect(d).toMatchObject({ rejectReason: "no_business_document", rejectText: null });
    expect(d?.rejectedAt).toEqual(expect.any(Number));
  });

  test("INB-027 „Beleg erfassen“ again: an existing draft is returned; only items „Zu prüfen“ get a new one", async () => {
    const t = makeT();
    const owner = await setup(t);
    const fresh = await store(t, { source: "upload", files: [await newFile(t, pdfBytes("redraft-new"), "n.pdf")] });
    expect((await errorOf(owner.mutation(api.inbox.createDraft, { id: fresh.id }))).message).toBe(
      "Für diesen Posteingangsbeleg kann kein Entwurf angelegt werden.",
    );
    const r = await ingest(t, owner, [{ bytes: pdfBytes("redraft"), name: "r.pdf" }]);
    await settleInbox(t);
    const it = await item(t, r.id);
    expect(await owner.mutation(api.inbox.createDraft, { id: r.id })).toBe(it.voucherId);
    // EC-VOU-36: the draft is deleted → the item returns to review; „Beleg erfassen“ creates a new empty draft.
    await owner.mutation(api.vouchers.deleteDraft, { id: it.voucherId as Id<"vouchers"> });
    const back = await item(t, r.id);
    expect(back.status).toBe("needs_review");
    expect(back.voucherId).toBeUndefined();
    const again = await owner.mutation(api.inbox.createDraft, { id: r.id });
    expect(again).not.toBe(it.voucherId);
    const after = await item(t, r.id);
    expect(after).toMatchObject({ status: "needs_review", voucherId: again, classification: "pdf" });
    expect((await voucherOf(t, again)).originalFiles[0]?.sha256).toBe(it.files[0]?.sha256);
    expect(await audit(t, "inbox.redraft")).toHaveLength(1);
  });

  test("SET-113 disabling OCR releases only items flagged ocr_pending; an image item is classified as image", async () => {
    const t = makeT();
    const owner = await setup(t);
    await enableOcr(owner);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7, 7]);
    const img = await store(t, { source: "app", files: [await newFile(t, jpeg, "foto.jpg", "image/jpeg")] });
    const plain = await store(t, { source: "upload", files: [await newFile(t, pdfBytes("ocr-plain"), "p.pdf")] });
    await t.run(async (ctx) => {
      await ctx.db.patch(img.id, { status: "processing", flags: ["ocr_pending"] });
      await ctx.db.patch(plain.id, { status: "processing" });
    });
    const res = await owner.mutation(api.inbox.saveOcr, { enabled: false, dpaConfirmed: true, region: "eu" });
    expect(res.released).toBe(1);
    const released = await item(t, img.id);
    expect(released).toMatchObject({ status: "needs_review", classification: "image" });
    expect(released.warnings?.map((w) => w.code)).toContain("ocr_disabled");
    const untouched = await item(t, plain.id);
    expect(untouched.status).toBe("processing");
    expect(untouched.voucherId).toBeUndefined();
    // Back to `new` so the invariants see a consistent queue (classification would pick it up).
    await t.run((ctx) => ctx.db.patch(plain.id, { status: "new" }));
  });
});

describe("split and merge (INB-009, GOBD-08)", () => {
  test("INB-009 invalid split groups, more than 10 items and an unparsed e-mail are refused", async () => {
    const t = makeT();
    const owner = await setup(t);
    const two = await store(t, {
      source: "upload",
      files: [await newFile(t, pdfBytes("sg-a"), "a.pdf"), await newFile(t, pdfBytes("sg-b"), "b.pdf")],
    });
    const bad = await errorOf(owner.mutation(api.inbox.split, { id: two.id, groups: [[0, 1]] }));
    expect(bad).toMatchObject({
      message: "Bitte jede Datei genau einem von mindestens zwei Teilen zuordnen.",
      data: expect.objectContaining({ reason: "SPLIT_MERGE_GROUPS" }),
    });
    const ids: Id<"inboxItems">[] = [];
    for (let i = 0; i < 11; i++) {
      ids.push((await store(t, { source: "upload", files: [await newFile(t, pdfBytes(`m-${i}`), `${i}.pdf`)] })).id);
    }
    expect((await errorOf(owner.mutation(api.inbox.merge, { ids }))).message).toBe(
      "Höchstens 10 Posteingangsbelege auf einmal zusammenführen.",
    );
    // The count check happens before anything is touched.
    expect((await item(t, ids[0] as Id<"inboxItems">)).status).toBe("new");
    const mail = await store(t, {
      source: "email",
      files: [await newFile(t, enc("raw"), "m.eml", "message/rfc822")],
    });
    const pending = await errorOf(owner.mutation(api.inbox.merge, { ids: [mail.id, two.id] }));
    expect(pending).toMatchObject({
      message: "Die E-Mail wird noch verarbeitet. Bitte kurz warten.",
      data: expect.objectContaining({ reason: "SPLIT_MERGE_STATE" }),
    });
  });

  test("INB-009 a merge of parsed e-mails keeps the Zugang context, skipped attachments, rendition and override", async () => {
    const t = makeT();
    const owner = await setup(t);
    const dupBytes = pdfBytes("merge-dup");
    const earlier = await store(t, { source: "upload", files: [await newFile(t, dupBytes, "frueher.pdf")] });
    const mailA = await store(t, {
      source: "email",
      files: [await newFile(t, enc("raw A"), "a.eml", "message/rfc822")],
      from: "rechnung@lieferant.de",
      to: "belege@in.example.de",
      subject: "Rechnung Teil 1",
      messageId: "teil1@lieferant.de",
      note: "Teil 1",
    });
    const rendition = await newFile(t, pdfBytes("merge-rendition"), "mail.pdf");
    await t.model(OWNER, async (ctx) =>
      recordMailParse(ctx, {
        id: mailA.id,
        mailText: "Teil 1 anbei",
        files: [],
        mailRendition: { storageId: rendition.storageId, sha256: rendition.sha256 },
        skipped: [{ name: "film.mov", mime: "video/quicktime", bytes: 99, reason: "unsupported" }],
        flags: ["no_attachment"],
        warnings: [],
        duplicateMessage: (d) => d,
      }),
    );
    // Part 2 repeats a file captured earlier: a duplicate the owner overrode with a reason.
    const dup = await store(t, { source: "upload", files: [await newFile(t, dupBytes, "teil2.pdf")] });
    expect(dup.status).toBe("duplicate");
    await t.model(OWNER, (ctx) =>
      auditedPatch(
        ctx,
        "inboxItems",
        dup.id,
        { duplicateOverride: { reason: "Zweite Seite gehört dazu", actor: OWNER.actor, at: Date.now() } },
        { action: "inbox.duplicate_override" },
      ),
    );
    const { id } = await owner.mutation(api.inbox.merge, { ids: [mailA.id, dup.id] });
    const merged = await item(t, id);
    expect(merged).toMatchObject({
      source: "email",
      from: "rechnung@lieferant.de",
      to: "belege@in.example.de",
      subject: "Rechnung Teil 1",
      messageId: "teil1@lieferant.de",
      mailText: "Teil 1 anbei",
      note: "Teil 1",
      mailParsed: true,
      status: "new",
      duplicateOverride: { reason: "Zweite Seite gehört dazu" },
    });
    expect(merged.skippedAttachments?.[0]?.name).toBe("film.mov");
    expect(merged.mailRendition?.sha256).toBe(rendition.sha256);
    expect(merged.duplicateOfInboxItemId).toBeUndefined();
    await settleInbox(t);
    const detail = await owner.query(api.inbox.get, { id });
    expect(detail?.createdFrom).toEqual({ kind: "merge", inboxItemIds: [mailA.id, dup.id] });
    const source = await owner.query(api.inbox.get, { id: mailA.id });
    expect(source?.supersededBy).toEqual({ kind: "merge", inboxItemIds: [id] });
    expect(source?.mailRenditionUrl).toMatch(/^https?:/);
    expect((await item(t, earlier.id)).status).toBe("new");
  });

  test("INB-009 VOU-050 a merge without override that repeats an earlier file stays a duplicate of it", async () => {
    const t = makeT();
    const owner = await setup(t);
    const dupBytes = pdfBytes("merge-dup-2");
    const earlier = await store(t, { source: "upload", files: [await newFile(t, dupBytes, "frueher.pdf")] });
    const a = await store(t, { source: "upload", files: [await newFile(t, dupBytes, "a.pdf")] });
    const b = await store(t, { source: "upload", files: [await newFile(t, pdfBytes("merge-b"), "b.pdf")] });
    const { id } = await owner.mutation(api.inbox.merge, { ids: [a.id, b.id] });
    const merged = await item(t, id);
    expect(merged).toMatchObject({ status: "duplicate", duplicateOfInboxItemId: earlier.id });
    expect(merged.warnings?.[0]?.code).toBe("duplicate_file");
    expect(merged.createdFrom?.kind).toBe("merge");
  });
});

describe("settings and e-mail-in internals (SET-110, INB-049, INB-052, EC-INB-29)", () => {
  test("SET-110 without credentials the inbox shows „fehlt“; the endpoint is shown; an invalid allowlist is refused", async () => {
    const t = makeT();
    const owner = await setup(t);
    delete process.env.R2_INBOX_FAKE;
    process.env.R2_ACCOUNT_ENDPOINT = "  https://konto.r2.cloudflarestorage.com  ";
    try {
      const s = await owner.query(api.inbox.settings, {});
      expect(s.inbox).toMatchObject({
        enabled: false,
        dpaConfirmedAt: null,
        receivingAddress: null,
        credentials: "missing",
        bucket: null,
        endpoint: "https://konto.r2.cloudflarestorage.com",
        lastTestAt: null,
        lastTestOk: null,
      });
      expect(s.ocr).toMatchObject({
        enabled: false,
        active: false,
        apiKeyStored: false,
        monthlyBudget: null,
        usage: null,
      });
      const r = await owner.action(api.inboxNode.testR2, {});
      expect(r).toEqual({
        ok: false,
        detail:
          "R2-Zugangsdaten fehlen (R2_ACCOUNT_ENDPOINT, R2_INBOX_BUCKET, R2_INBOX_ACCESS_KEY_ID, R2_INBOX_SECRET_ACCESS_KEY).",
      });
      expect((await owner.query(api.inbox.settings, {})).inbox.lastTestOk).toBe(false);
    } finally {
      delete process.env.R2_ACCOUNT_ENDPOINT;
    }
    const e = await errorOf(enableInbox(owner, { allowlist: "@lieferant.de\nkeine adresse" }));
    expect(e).toMatchObject({
      code: "invalid_input",
      message: "Ungültige Einträge in der Absenderliste: keine adresse",
    });
  });

  test("INB-049 the stored e-mail keeps its normalised headers and etag; pollState reports disabled and paused", async () => {
    const t = makeT();
    const owner = await setup(t);
    expect(await t.query(internal.inbox.pollState, {})).toEqual({ enabled: false, paused: false });
    const raw = enc("From: x@y.de\r\n\r\nText");
    const f = await newFile(t, raw, "1-a.eml", "message/rfc822");
    const r = await t.mutation(internal.inbox.storeEmailInternal, {
      bucket: "test-inbox",
      objectKey: "inbox/1-a.eml",
      etag: '"abc"',
      lastModified: 1_760_000_000_000,
      file: f,
      from: "x@y.de",
      to: "belege@in.example.de",
      subject: "Beleg",
      messageId: "<id-1@y.de>",
    });
    const it = await item(t, r.id);
    expect(it).toMatchObject({
      source: "email",
      receivedAt: 1_760_000_000_000,
      r2: { bucket: "test-inbox", objectKey: "inbox/1-a.eml", etag: '"abc"' },
      from: "x@y.de",
      to: "belege@in.example.de",
      subject: "Beleg",
      messageId: "id-1@y.de",
    });
    expect(await t.query(internal.inbox.r2ObjectKnown, { bucket: "test-inbox", objectKey: "inbox/1-a.eml" })).toBe(
      true,
    );
    expect(await t.query(internal.inbox.r2ObjectKnown, { bucket: "test-inbox", objectKey: "inbox/2-b.eml" })).toBe(
      false,
    );
    await settleInbox(t);

    await enableInbox(owner);
    await t.mutation(internal.inbox.r2TestInternal, {
      actorContext: OWNER,
      ok: false,
      detail: "HTTP 403",
      unauthorized: true,
    });
    expect(await t.query(internal.inbox.pollState, {})).toEqual({ enabled: true, paused: true });
    let s = await owner.query(api.inbox.settings, {});
    expect(s.inbox).toMatchObject({ lastTestOk: false, lastTestDetail: "HTTP 403" });
    expect(s.inbox.health.lastError).toBe("HTTP 403");
    // A failed (not unauthorized) test does not resume; a successful one with a count resumes.
    await t.mutation(internal.inbox.r2TestInternal, { actorContext: OWNER, ok: false, detail: "HTTP 500" });
    expect((await t.query(internal.inbox.pollState, {})).paused).toBe(true);
    await t.mutation(internal.inbox.r2TestInternal, { actorContext: OWNER, ok: true, detail: "ok", objectsWaiting: 4 });
    s = await owner.query(api.inbox.settings, {});
    expect(s.inbox.health).toMatchObject({ objectsWaiting: 4, consecutiveFailures: 0 });
    expect(s.inbox.health.pausedAt).toBeUndefined();
  });
});
