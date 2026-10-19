import { env } from "./env";

/**
 * ntfy transport (F12 NTF-004). JSON publishing to the configured server (`POST {serverUrl}` with `topic` in the
 * body, optional bearer token). Behind an interface so tests and E2E use the memory transport
 * (`NTFY_SENDER=memory`: messages land in the dev mailbox as kind `ntfy`). Never throws; failures are counted by
 * the caller (E-NTF-01).
 */
export interface NtfyMessage {
  topic: string;
  title: string;
  message: string;
  priority: number;
  click?: string;
}

export type NtfyResult = { ok: true } | { ok: false; detail: string };

export interface NtfySender {
  readonly name: string;
  publish(serverUrl: string, msg: NtfyMessage, token?: string): Promise<NtfyResult>;
}

export function httpNtfySender(fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): NtfySender {
  return {
    name: "http",
    async publish(serverUrl, msg, token) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(serverUrl.replace(/\/+$/, ""), {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(msg),
          signal: controller.signal,
        });
        return res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function memoryNtfySender(store: (msg: NtfyMessage) => Promise<void>): NtfySender {
  return {
    name: "memory",
    async publish(_serverUrl, msg) {
      await store(msg);
      return { ok: true };
    },
  };
}

export function ntfySenderFromEnv(store: (msg: NtfyMessage) => Promise<void>): NtfySender {
  return env("NTFY_SENDER") === "memory" ? memoryNtfySender(store) : httpNtfySender();
}

/** NTF-004: the server URL must be http(s); a plain-http URL is only accepted for tailnet/local hosts. */
export function ntfyServerProblem(serverUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return "Bitte eine gültige ntfy-Server-Adresse angeben (https://…).";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && /(\.ts\.net|\.local|localhost|^\d+\.\d+\.\d+\.\d+)$/.test(url.hostname)) return null;
  return "Die ntfy-Server-Adresse muss mit https:// beginnen.";
}

/** ntfy.sh is a third-party service outside the operator's control (DSGVO-04): the UI warns. */
export const isPublicNtfy = (serverUrl: string): boolean => {
  try {
    return new URL(serverUrl).hostname.endsWith("ntfy.sh");
  } catch {
    return false;
  }
};
