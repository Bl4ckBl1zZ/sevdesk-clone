import { describe, expect, test, vi } from "vitest";
import manifest from "@/app/manifest";
import { handleShareTarget, SHARE_TARGET_FIELD } from "./share-target";

const pdf = (name: string, size = 64) => new File([new Uint8Array(size).fill(0x25)], name, { type: "application/pdf" });

function shareRequest(files: File[], headers: Record<string, string> = {}): Request {
  const body = new FormData();
  body.set("title", "Rechnung");
  for (const f of files) body.append(SHARE_TARGET_FIELD, f);
  return new Request("https://app.example.test/share-target", { method: "POST", body, headers });
}

describe("PWA share target (INB-004)", () => {
  test("INB-004 T06-005 the manifest declares a multipart POST share target for receipts", () => {
    const m = manifest();
    expect(m.share_target).toEqual({
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        url: "url",
        files: [
          {
            name: SHARE_TARGET_FIELD,
            accept: [
              "application/pdf",
              "image/*",
              "application/xml",
              "text/xml",
              "message/rfc822",
              ".pdf",
              ".xml",
              ".eml",
            ],
          },
        ],
      },
    });
  });

  test("INB-004 T06-005 each shared file becomes an inbox item with source „app“; the user lands on the item", async () => {
    const ingest = vi.fn(async (_f: { filename: string; contentBase64: string }) => ({
      id: `inb${ingest.mock.calls.length}`,
    }));
    const requireWriter = vi.fn(async () => undefined);
    const res = await handleShareTarget(shareRequest([pdf("a.pdf"), pdf("b.pdf")]), { requireWriter, ingest });
    expect(requireWriter).toHaveBeenCalledOnce();
    expect(ingest.mock.calls.map(([f]) => f.filename)).toEqual(["a.pdf", "b.pdf"]);
    expect(atob(ingest.mock.calls[0]?.[0].contentBase64 ?? "")).toBe("%".repeat(64));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/posteingang?id=inb2");
  });

  test("INB-004 SEC-06 cross-site posts, signed-out callers, empty shares and oversized files are refused", async () => {
    const ingest = vi.fn(async () => ({ id: "x" }));
    const ok = async () => undefined;
    const cross = await handleShareTarget(shareRequest([pdf("a.pdf")], { "sec-fetch-site": "cross-site" }), {
      requireWriter: ok,
      ingest,
    });
    expect(cross.status).toBe(403);
    const denied = await handleShareTarget(shareRequest([pdf("a.pdf")]), {
      requireWriter: async () => {
        throw Object.assign(new Error("Keine Berechtigung."), { status: 403 });
      },
      ingest,
    });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe("Keine Berechtigung.");
    const empty = await handleShareTarget(shareRequest([]), { requireWriter: ok, ingest });
    expect(empty.status).toBe(303);
    expect(empty.headers.get("location")).toBe("/posteingang?geteilt=0");
    // > 10 MB base64 (≈ 7.5 MB file) cannot be handed over; the others still are.
    const big = await handleShareTarget(shareRequest([pdf("gross.pdf", 8 * 1024 * 1024), pdf("klein.pdf")]), {
      requireWriter: ok,
      ingest,
    });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(big.headers.get("location")).toBe("/posteingang?id=x&abgelehnt=1");
  });
});
