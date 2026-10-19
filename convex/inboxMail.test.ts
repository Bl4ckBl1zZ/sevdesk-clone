import { plainPdf } from "@test/fixtures/einvoice-in/builders";
import { describe, expect, test } from "vitest";
import { sha256Hex } from "../src/domain/audit/chain";
import { api, internal } from "./_generated/api";
import { eml, enableInbox, enc, installInboxFakes, item, putR2, settleInbox } from "./inbox.fixtures";
import { memoryInbox } from "./lib/r2Inbox";
import { makeT, type TestT } from "./test.setup";
import { setupCompany } from "./vouchers.fixtures";

installInboxFakes();

const BUCKET = "test-inbox";
const poll = (t: TestT) => t.action(internal.inboxNode.pollR2, { force: true });
const items = (t: TestT) => t.run((ctx) => ctx.db.query("inboxItems").collect());

async function setup(t: TestT, over: Record<string, unknown> = {}) {
  await setupCompany(t);
  const owner = await t.asUser("owner");
  await enableInbox(owner, over);
  return owner;
}

describe("e-mail-in R2 poll (INB-049, EC-INB-23/27)", () => {
  test("INB-049 INB-050 GOBD-08 T06-153 one item per message: .eml original = object bytes, PDF extracted, logo/cid skipped, DELETE after commit", async () => {
    const t = makeT();
    await setup(t);
    const pdf = await plainPdf(["Rechnung 4711"]);
    const raw = eml({
      subject: "Rechnung 4711",
      html: '<p>Anbei</p><img src="cid:sig@x">',
      attachments: [
        { name: "rechnung.pdf", mime: "application/pdf", bytes: pdf },
        {
          name: "logo.png",
          mime: "image/png",
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]),
          inline: true,
        },
        {
          name: "sig.png",
          mime: "image/png",
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3, 4]),
          cid: "sig@x",
        },
      ],
    });
    const lastModified = Date.now() - 120_000;
    putR2("inbox/1700000000000-a.eml", raw, lastModified);
    const r = await poll(t);
    expect(r).toMatchObject({ imported: 1, deleted: 1, failed: 0 });
    // DELETE only after the commit: the object is gone and the item exists.
    expect(memoryInbox.objects.size).toBe(0);
    expect(memoryInbox.calls.delete).toEqual(["inbox/1700000000000-a.eml"]);
    await settleInbox(t);
    const [it] = await items(t);
    expect(it?.source).toBe("email");
    expect(it?.receivedAt).toBe(lastModified);
    expect(it?.r2).toMatchObject({ bucket: BUCKET, objectKey: "inbox/1700000000000-a.eml" });
    expect(it?.actor).toBe("system:cron.inbox.pollR2");
    expect(it?.files[0]).toMatchObject({ role: "eml", mime: "message/rfc822" });
    expect(it?.files[0]?.sha256).toBe(await sha256Hex(raw));
    expect(it?.files.map((f) => f.name)).toEqual(["1700000000000-a.eml", "rechnung.pdf"]);
    expect(it?.files[1]).toMatchObject({ role: "original", derivedFrom: 0 });
    expect(it?.files[1]?.sha256).toBe(await sha256Hex(pdf));
    expect(it?.subject).toBe("Rechnung 4711");
    expect(it?.status).toBe("needs_review");
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((a) => a.action === "inbox.capture")?.actor).toBe("system:cron.inbox.pollR2");
  });

  test("INB-049 EC-INB-23 T06-154 idempotent: crash after commit → next run deletes without a new item", async () => {
    const t = makeT();
    await setup(t);
    putR2(
      "inbox/1-a.eml",
      eml({ attachments: [{ name: "a.pdf", mime: "application/pdf", bytes: await plainPdf(["a"]) }] }),
    );
    memoryInbox.failDelete.add("inbox/1-a.eml");
    const first = await poll(t);
    expect(first).toMatchObject({ imported: 1, deleted: 0, failed: 1 });
    expect(memoryInbox.objects.size).toBe(1);
    memoryInbox.failDelete.clear();
    const second = await poll(t);
    expect(second).toMatchObject({ imported: 0, deleted: 1 });
    expect(await items(t)).toHaveLength(1);
    expect(memoryInbox.objects.size).toBe(0);
    // A racing second import of the same object loses inside the transaction.
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));
    const lost = await t.mutation(internal.inbox.storeEmailInternal, {
      bucket: BUCKET,
      objectKey: "inbox/1-a.eml",
      lastModified: Date.now(),
      file: { storageId, sha256: "0".repeat(64), name: "1-a.eml", mime: "message/rfc822", bytes: 1 },
    });
    expect(lost.existed).toBe(true);
    expect(await items(t)).toHaveLength(1);
  });

  test("INB-049 EC-INB-27 EC-INB-32 T06-155 a failing GET leaves that object; others continue; ≤ 50 per run oldest first; foreign keys ignored", async () => {
    const t = makeT();
    await setup(t);
    const base = Date.now() - 3_600_000 * 2;
    for (let i = 0; i < 3; i++) putR2(`inbox/${i}-m.eml`, eml({ text: `Mail ${i}` }), base + i);
    putR2("other/readme.txt", enc("hallo"), base);
    memoryInbox.failGet.set("inbox/1-m.eml", 500);
    const r = await poll(t);
    expect(r).toMatchObject({ imported: 2, deleted: 2, failed: 1 });
    expect([...memoryInbox.objects.keys()].sort()).toEqual(["inbox/1-m.eml", "other/readme.txt"]);
    memoryInbox.failGet.clear();
    expect(await poll(t)).toMatchObject({ imported: 1, deleted: 1 });
    expect(memoryInbox.objects.has("other/readme.txt")).toBe(true);
    expect(memoryInbox.calls.delete).not.toContain("other/readme.txt");

    memoryInbox.reset();
    for (let i = 0; i < 120; i++) putR2(`inbox/${String(i).padStart(3, "0")}-x.eml`, eml({ text: `n${i}` }), base + i);
    const big = await poll(t);
    expect(big.imported).toBe(50);
    expect(memoryInbox.calls.get[0]).toBe("inbox/000-x.eml");
    expect(memoryInbox.objects.size).toBe(70);
  }, 60_000);

  test("INB-050 EC-INB-24 VOU-050 T06-158 the same Message-ID again → duplicate linked to the first, never dropped", async () => {
    const t = makeT();
    await setup(t);
    putR2("inbox/1-a.eml", eml({ messageId: "abc@lieferant.de", text: "erste" }), Date.now() - 2000);
    await poll(t);
    await settleInbox(t);
    putR2("inbox/2-b.eml", eml({ messageId: "abc@lieferant.de", text: "zweite, anderer Inhalt" }), Date.now() - 1000);
    await poll(t);
    await settleInbox(t);
    const all = (await items(t)).sort((a, b) => a.receivedAt - b.receivedAt);
    expect(all).toHaveLength(2);
    expect(all[1]?.status).toBe("duplicate");
    expect(all[1]?.duplicateOfInboxItemId).toBe(all[0]?._id);
    expect(all[1]?.warnings?.find((w) => w.code === "duplicate_message")?.message).toMatch(
      /^Diese E-Mail wurde bereits empfangen \(/,
    );
    // Identical bytes in a second object hit the exact-hash duplicate (VOU-050) already at capture.
    const raw = eml({ messageId: "same@x.de", text: "gleich" });
    putR2("inbox/3-c.eml", raw);
    putR2("inbox/4-d.eml", raw, Date.now() + 1);
    await poll(t);
    await settleInbox(t);
    const dupes = (await items(t)).filter((i) => i.status === "duplicate");
    expect(dupes).toHaveLength(2);
  });

  test("INB-050 EC-INB-26 EC-INB-30 EC-INB-21 T06-156 oversize attachment listed, garbage → mail_unparseable, no attachment → hint", async () => {
    const t = makeT();
    await setup(t);
    const big = new Uint8Array(21 * 1024 * 1024);
    big.set(enc("%PDF-1.7\n"));
    putR2("inbox/1-big.eml", eml({ attachments: [{ name: "scan.pdf", mime: "application/pdf", bytes: big }] }));
    putR2("inbox/2-garbage.eml", new Uint8Array([0, 159, 146, 150, 1, 2, 3]));
    putR2("inbox/3-text.eml", eml({ text: "Ihre Rechnung finden Sie unter https://example.com/r/1" }));
    await poll(t);
    await settleInbox(t);
    const byKey = new Map((await items(t)).map((i) => [i.r2?.objectKey, i]));
    const bigItem = byKey.get("inbox/1-big.eml");
    expect(bigItem?.flags).toContain("attachment_too_large");
    expect(bigItem?.skippedAttachments?.[0]).toMatchObject({ name: "scan.pdf", reason: "too_large" });
    expect(bigItem?.files).toHaveLength(1);
    expect(bigItem?.status).toBe("needs_review");
    const garbage = byKey.get("inbox/2-garbage.eml");
    expect(garbage?.flags).toContain("mail_unparseable");
    expect(garbage?.files[0]?.role).toBe("eml");
    expect(garbage?.status).toBe("needs_review");
    const text = byKey.get("inbox/3-text.eml");
    expect(text?.warnings?.map((w) => w.message)).toContain(
      "Keine Anlage gefunden – Rechnung ist ggf. im E-Mail-Text oder über einen Link abrufbar.",
    );
    // INB-030: the body is kept as untrusted plain text.
    expect(text?.mailText).toContain("https://example.com/r/1");
  }, 60_000);

  test("EC-INB-06 EC-INB-31 EC-INB-33 T06-009 T06-157 unknown sender and failed DMARC are flagged, never dropped; reject no_business_document", async () => {
    const t = makeT();
    const owner = await setup(t, { allowlist: "@lieferant.de" });
    putR2("inbox/1-ok.eml", eml({ from: "a@lieferant.de", text: "ok" }), Date.now() - 3000);
    putR2(
      "inbox/2-news.eml",
      eml({
        from: "news@spam.example",
        text: "Newsletter",
        headers: ["Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom=spam.example; dmarc=fail"],
      }),
      Date.now() - 2000,
    );
    await poll(t);
    await settleInbox(t);
    const byKey = new Map((await items(t)).map((i) => [i.r2?.objectKey, i]));
    expect(byKey.get("inbox/1-ok.eml")?.flags ?? []).not.toContain("unknown_sender");
    const news = byKey.get("inbox/2-news.eml");
    expect(news?.flags).toEqual(expect.arrayContaining(["unknown_sender", "sender_auth_failed"]));
    expect(news?.warnings?.find((w) => w.code === "sender_auth_failed")?.acknowledge).toBe(true);
    expect(news?.status).toBe("needs_review");
    expect(memoryInbox.objects.size).toBe(0);
    await owner.mutation(api.inbox.reject, { id: news?._id as never, reason: "no_business_document" });
    const rejected = await item(t, news?._id as never);
    expect(rejected.purgeEligibleFrom).toBeDefined();
  });
});

describe("e-mail-in health (INB-052, SET-110, EC-INB-28/29)", () => {
  test("INB-052 EC-INB-29 T06-159 401 pauses polling with a notification; a successful test resumes", async () => {
    const t = makeT();
    const owner = await setup(t);
    memoryInbox.listStatus = 401;
    expect((await poll(t)).failed).toBe(1);
    let s = await owner.query(api.inbox.settings, {});
    expect(s.inbox.health.pausedAt).toBeDefined();
    const n = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(n.find((x) => x.kind === "inbox_unreachable")?.title).toMatch(/^E-Mail-Posteingang nicht erreichbar: /);
    putR2("inbox/1-a.eml", eml({ text: "a" }));
    memoryInbox.listStatus = null;
    expect(await poll(t)).toMatchObject({ skipped: "paused" });
    const test = await owner.action(api.inboxNode.testR2, {});
    expect(test).toMatchObject({ ok: true, objects: 1 });
    s = await owner.query(api.inbox.settings, {});
    expect(s.inbox.health.pausedAt).toBeUndefined();
    expect(s.inbox.lastTestOk).toBe(true);
    expect((await poll(t)).imported).toBe(1);
  });

  test("INB-052 EC-INB-28 T06-159 an object older than 60 min or 3 failed runs raises a notification", async () => {
    const t = makeT();
    await setup(t);
    putR2("inbox/1-old.eml", eml({ text: "alt" }), Date.now() - 2 * 3_600_000);
    memoryInbox.failGet.set("inbox/1-old.eml", 500);
    await poll(t);
    const n = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(n.find((x) => x.kind === "inbox_stale")?.title).toMatch(
      /^E-Mail-Posteingang: 1 Nachricht\(en\) konnten seit .* nicht importiert werden\.$/,
    );
  });

  test("SET-110 INB-052 DSGVO-04 settings show address, bucket, credentials state; keys never stored; AVV required", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    await expect(enableInbox(owner, { dpaConfirmed: false })).rejects.toThrow(/Auftragsverarbeitungsvertrag/);
    await enableInbox(owner, { allowlist: "@lieferant.de\nbuchhaltung@partner.de" });
    const s = await owner.query(api.inbox.settings, {});
    expect(s.inbox).toMatchObject({
      enabled: true,
      receivingAddress: "belege@in.example.de",
      allowlist: ["@lieferant.de", "buchhaltung@partner.de"],
      credentials: "configured",
      bucket: BUCKET,
      pollIntervalMinutes: 5,
      limits: { mailMb: 25, attachmentMb: 20 },
    });
    const rows = await t.run((ctx) => ctx.db.query("integrations").collect());
    expect(JSON.stringify(rows)).not.toMatch(/SECRET|ACCESS_KEY|secretAccessKey|accessKeyId/i);
    // Disabled → the cron does nothing.
    await owner.mutation(api.inbox.saveInbox, { enabled: false, allowlist: "", dpaConfirmed: true });
    putR2("inbox/1-a.eml", eml({ text: "a" }));
    expect(await poll(t)).toMatchObject({ skipped: "disabled" });
  });
});
