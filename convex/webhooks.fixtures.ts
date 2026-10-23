import { vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { TestT } from "./test.setup";

/**
 * Webhook test fixtures (not a Convex module: multi-dot file name). Test files that subscribe an endpoint also mock
 * DNS so the SSRF guard never resolves for real:
 *
 *   vi.mock("./lib/webhookDns", () => ({ resolveHost: async () => ["93.184.216.34"] }));
 */
export const HOOK = "https://shop.example.com/hooks/rechnung";

export interface SentHook {
  headers: Record<string, string>;
  body: string;
}

/**
 * Stubs `fetch`: requests to HOOK answer 204 and are recorded; everything else goes to `inner` (e.g. a fake bank
 * provider) or answers 500.
 */
export function stubHookFetch(inner?: (url: string, init?: RequestInit) => Promise<Response>): SentHook[] {
  const sent: SentHook[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === HOOK) {
        sent.push({ headers: init?.headers as Record<string, string>, body: String(init?.body) });
        return new Response(null, { status: 204 });
      }
      return inner ? inner(url, init) : new Response("unexpected", { status: 500 });
    }),
  );
  return sent;
}

type Owner = { action: (ref: typeof api.webhooks.create, args: { values: unknown }) => Promise<{ secret: string }> };

/** The owner subscribes HOOK to `events` (default: every event). */
export async function subscribeHook(owner: Owner, events: string[] = ["*"]) {
  return owner.action(api.webhooks.create, { values: { url: HOOK, events } });
}

export const outbox = (t: TestT): Promise<Doc<"webhookEvents">[]> =>
  t.run((ctx) => ctx.db.query("webhookEvents").collect());
export const outboxTypes = async (t: TestT) => (await outbox(t)).map((e) => e.type);
export const outboxOf = async (t: TestT, type: string) => (await outbox(t)).filter((e) => e.type === type);
export const objectOf = (e: Doc<"webhookEvents"> | undefined) => (e?.object ?? {}) as Record<string, unknown>;
