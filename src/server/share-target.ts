/**
 * PWA share target (F06 INB-004, 04 §10): the manifest's `share_target` POSTs the shared files as
 * `multipart/form-data` to `/share-target` on `app.`. Each file becomes one inbox item with `source = "app"` through
 * the same Convex action as REST/MCP (`inbox.ingestBase64`, magic-byte check, SHA-256, capture metadata); the browser
 * is redirected (303) to the Posteingang. Signed-in session and `vouchers.write` required; cross-site posts are
 * refused (the share sheet navigation is same-origin). Files above the 10 MB base64 limit of that action (≈ 7.5 MB)
 * are skipped and counted (`abgelehnt`) — they can still be uploaded in the Posteingang (20 MB).
 */

export const SHARE_TARGET_FIELD = "files";
/** inbox.ingestBase64 accepts ≤ 10 MB base64 per file (EC-INB-02). */
const MAX_BASE64_CHARS = 10 * 1024 * 1024;
const MAX_FILES = 20;

export interface ShareTargetDeps {
  /** Session + `vouchers.write`; throws an error with `status` 401/403 and a German message otherwise. */
  requireWriter: () => Promise<void>;
  /** Creates one inbox item (source „app“) from one file. */
  ingest: (file: { filename: string; contentBase64: string }) => Promise<{ id: string }>;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const redirect = (location: string) => new Response(null, { status: 303, headers: { Location: location } });

export async function handleShareTarget(request: Request, deps: ShareTargetDeps): Promise<Response> {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return new Response("Teilen ist nur aus der installierten App möglich.", { status: 403 });
  }
  try {
    await deps.requireWriter();
  } catch (e) {
    const status = (e as { status?: number }).status ?? 403;
    return new Response((e as Error).message, { status });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response("Die geteilten Daten konnten nicht gelesen werden.", { status: 400 });
  }
  const files = form
    .getAll(SHARE_TARGET_FIELD)
    .filter((f): f is File => typeof f !== "string" && f.size > 0)
    .slice(0, MAX_FILES);
  if (files.length === 0) return redirect("/posteingang?geteilt=0");
  let last: string | null = null;
  let refused = 0;
  for (const f of files) {
    const contentBase64 = toBase64(new Uint8Array(await f.arrayBuffer()));
    if (contentBase64.length > MAX_BASE64_CHARS) {
      refused++;
      continue;
    }
    try {
      last = (await deps.ingest({ filename: f.name || "geteilt", contentBase64 })).id;
    } catch {
      refused++; // unsupported type etc. — the Convex action rejected it (EC-INB-01)
    }
  }
  const params = new URLSearchParams();
  if (last) params.set("id", last);
  if (refused > 0) params.set("abgelehnt", String(refused));
  return redirect(`/posteingang?${params.toString()}`);
}
