/**
 * F06 SHOULD inbox features: share target (INB-004), mail without attachment (INB-007), split/merge (INB-009),
 * supplier correction request (INB-046).
 */

import { pdfText } from "@test/golden/pdf-text";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { eml, enableInbox, installInboxFakes, item, putR2, settleInbox, voucherOf } from "./inbox.fixtures";
import { makeT, type TestT } from "./test.setup";
import { pdfBytes, setupCompany } from "./vouchers.fixtures";

installInboxFakes();

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

async function setup(t: TestT) {
  await setupCompany(t);
  return t.asUser("owner");
}

describe("PWA share target (INB-004)", () => {
  test("INB-004 T06-005 a shared file from a signed-in app session becomes an item with source „app“; API keys cannot claim it", async () => {
    const t = makeT();
    const owner = await setup(t);
    const r = await owner.action(api.inbox.ingestBase64, {
      files: [{ filename: "geteilt.pdf", contentBase64: b64(pdfBytes("share-1")) }],
      via: "app",
    });
    expect((await item(t, r.id)).source).toBe("app");
    const key = await t.asApiKey(["vouchers:write", "vouchers:read"]);
    const k = await key.action(api.inbox.ingestBase64, {
      files: [{ filename: "api.pdf", contentBase64: b64(pdfBytes("share-2")) }],
      via: "app",
    });
    expect((await item(t, k.id)).source).toBe("api");
  });
});

describe("mail without attachment (INB-007, EC-INB-21)", () => {
  test("INB-007 EC-INB-21 T06-011 the .eml stays the original; a PDF rendition of the body is created; „Zu prüfen“ with the link hint", async () => {
    const t = makeT();
    const owner = await setup(t);
    await enableInbox(owner);
    putR2(
      "inbox/1700000000000-link.eml",
      eml({
        subject: "Ihre Rechnung 4711 ist online",
        html: '<p>Ihre Rechnung über 59,90 € finden Sie <a href="https://shop.example/r/4711">hier</a>: https://shop.example/r/4711</p>',
      }),
    );
    await t.action(internal.inboxNode.pollR2, { force: true });
    await settleInbox(t);
    const [it] = await t.run((ctx) => ctx.db.query("inboxItems").collect());
    if (!it) throw new Error("no item");
    expect(it.status).toBe("needs_review");
    expect(it.files.map((f) => f.role)).toEqual(["eml"]);
    expect(it.flags).toContain("no_attachment");
    expect(it.warnings?.map((w) => w.message)).toContain(
      "Keine Anlage gefunden – Rechnung ist ggf. im E-Mail-Text oder über einen Link abrufbar.",
    );
    expect(it.mailRendition?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const bytes = new Uint8Array(
      await t.run(async (ctx) => {
        const blob = it.mailRendition ? await ctx.storage.get(it.mailRendition.storageId) : null;
        return blob ? blob.arrayBuffer() : new ArrayBuffer(0);
      }),
    );
    const text = await pdfText(bytes);
    expect(text).toContain("Darstellung der E-Mail – nicht das Original");
    expect(text).toContain("https://shop.example/r/4711");
    // The draft carries it as a rendition of the .eml, never as an original.
    const v = await voucherOf(t, it.voucherId as Id<"vouchers">);
    expect(v.originalFiles.map((f) => f.role)).toEqual(["eml"]);
    expect(v.renditions).toMatchObject([{ kind: "html_pdf", ofFileIndex: 0, sha256: it.mailRendition?.sha256 }]);
    expect((await owner.query(api.inbox.get, { id: it._id }))?.mailRenditionUrl).toMatch(/^https?:/);
  });
});
