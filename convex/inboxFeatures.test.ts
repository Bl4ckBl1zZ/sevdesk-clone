/**
 * F06 SHOULD inbox features: share target (INB-004), mail without attachment (INB-007), split/merge (INB-009),
 * supplier correction request (INB-046).
 */
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { installInboxFakes, item } from "./inbox.fixtures";
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
