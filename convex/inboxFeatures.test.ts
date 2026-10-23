/**
 * F06 SHOULD inbox features: share target (INB-004), mail without attachment (INB-007), split/merge (INB-009),
 * supplier correction request (INB-046).
 */

import { pdfText } from "@test/golden/pdf-text";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { eml, enableInbox, ingest, installInboxFakes, item, putR2, settleInbox, voucherOf } from "./inbox.fixtures";
import { makeT, type TestT } from "./test.setup";
import { header, pdfBytes, setupCompany } from "./vouchers.fixtures";

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

describe("split / merge (INB-009)", () => {
  test("INB-009 T06-013 GOBD-08 split: new items carry the unchanged files (same blob and hash); the source stays, superseded, and its draft is gone", async () => {
    const t = makeT();
    const owner = await setup(t);
    const r = await ingest(t, owner, [
      { bytes: pdfBytes("split-a"), name: "a.pdf" },
      { bytes: pdfBytes("split-b"), name: "b.pdf" },
    ]);
    await settleInbox(t);
    const before = await item(t, r.id);
    expect(before.status).toBe("needs_review");
    const draftId = before.voucherId as Id<"vouchers">;
    const { ids } = await owner.mutation(api.inbox.split, { id: r.id, groups: [[0], [1]] });
    await settleInbox(t);
    expect(ids).toHaveLength(2);
    const parts = await Promise.all(ids.map((id) => item(t, id)));
    expect(parts.map((p) => p.files.map((f) => [f.name, f.sha256, f.storageId, f.capturedAt]))).toEqual([
      [[before.files[0]?.name, before.files[0]?.sha256, before.files[0]?.storageId, before.files[0]?.capturedAt]],
      [[before.files[1]?.name, before.files[1]?.sha256, before.files[1]?.storageId, before.files[1]?.capturedAt]],
    ]);
    // Each part is classified on its own (no duplicate of its own source) and gets its own draft.
    expect(parts.map((p) => p.status)).toEqual(["needs_review", "needs_review"]);
    expect(parts.every((p) => p.createdFrom?.kind === "split" && p.createdFrom.inboxItemIds[0] === r.id)).toBe(true);
    expect(parts.map((p) => p.receivedAt)).toEqual([before.receivedAt, before.receivedAt]);
    const after = await item(t, r.id);
    expect(after.status).toBe("superseded");
    expect(after.files).toEqual(before.files);
    expect(after.supersededBy).toMatchObject({
      kind: "split",
      inboxItemIds: ids,
      actor: expect.stringMatching(/^user:/),
    });
    expect(await voucherOf(t, draftId)).toBeNull();
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.filter((a) => a.action === "inbox.split").map((a) => a.entity.id)).toEqual(
      expect.arrayContaining([...ids, r.id]),
    );
    // A superseded item cannot be split, merged or rejected again.
    await expect(owner.mutation(api.inbox.split, { id: r.id, groups: [[0], [1]] })).rejects.toThrow(
      "Nur offene Posteingangsbelege können aufgeteilt oder zusammengeführt werden.",
    );
    await expect(
      owner.mutation(api.inbox.reject, { id: r.id, reason: "other", text: "falsch erfasst" }),
    ).rejects.toThrow("Dieser Beleg kann in seinem aktuellen Status nicht abgelehnt werden.");
  });

  test("INB-009 T06-013 merge front and back photo into one item; a booked draft blocks; viewers cannot", async () => {
    const t = makeT();
    const owner = await setup(t);
    const front = await ingest(t, owner, [{ bytes: pdfBytes("front"), name: "vorne.pdf" }]);
    const back = await ingest(t, owner, [{ bytes: pdfBytes("back"), name: "hinten.pdf" }]);
    await settleInbox(t);
    const viewer = await t.asUser("viewer");
    await expect(viewer.mutation(api.inbox.merge, { ids: [front.id, back.id] })).rejects.toThrow();
    await expect(owner.mutation(api.inbox.merge, { ids: [front.id] })).rejects.toThrow(
      "Bitte mindestens zwei Posteingangsbelege zum Zusammenführen auswählen.",
    );
    const { id } = await owner.mutation(api.inbox.merge, { ids: [front.id, back.id] });
    await settleInbox(t);
    const merged = await item(t, id);
    const [f, b] = [await item(t, front.id), await item(t, back.id)];
    expect(merged.files.map((x) => x.sha256)).toEqual([f.files[0]?.sha256, b.files[0]?.sha256]);
    expect(merged.createdFrom).toMatchObject({ kind: "merge", inboxItemIds: [front.id, back.id] });
    expect(merged.status).toBe("needs_review");
    expect([f.status, b.status]).toEqual(["superseded", "superseded"]);
    expect(f.supersededBy?.inboxItemIds).toEqual([id]);
    // The merged draft carries both originals; once booked, the item cannot be split any more.
    const v = await voucherOf(t, merged.voucherId as Id<"vouchers">);
    expect(v.originalFiles.map((x) => x.sha256)).toEqual(merged.files.map((x) => x.sha256));
    await owner.mutation(api.vouchers.updateDraft, { id: v._id, input: header() });
    await owner.mutation(api.vouchers.finalize, { id: v._id });
    expect((await item(t, id)).status).toBe("converted");
    await expect(owner.mutation(api.inbox.split, { id, groups: [[0], [1]] })).rejects.toThrow(
      "Nur offene Posteingangsbelege können aufgeteilt oder zusammengeführt werden.",
    );
  });
});
