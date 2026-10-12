import type { MailContent } from "../../src/emails/auth-mails";
import { appName, env } from "./env";

/**
 * Auth-mail transport (02 §9, F01 §3.10/§5.9). The app never e-mails customers — only sign-in codes,
 * invitations and owner notifications. Behind the `AuthMailSender` interface so Resend/SMTP could replace
 * the Cloudflare beta service.
 *
 * Selection by `AUTH_MAIL_SENDER`: `cloudflare` (default, production) | `memory` (tests/E2E: mails land in the
 * `devMailbox` table so tests can read the code) | `console` (local dev: logged).
 */
export interface AuthMail extends MailContent {
  to: string;
  /** e.g. "otp.sign-in", "invite", "test" — for the dev mailbox and logs, never sent. */
  kind: string;
}

export type AuthMailErrorCode =
  | "EMAIL_NOT_CONFIGURED"
  | "EMAIL_TOKEN_REJECTED"
  | "EMAIL_PLAN_REQUIRED"
  | "EMAIL_SENDING_DISABLED"
  | "EMAIL_THROTTLED"
  | "EMAIL_SENDER_NOT_ONBOARDED"
  | "EMAIL_UNREACHABLE"
  | "EMAIL_ERROR";

export type AuthMailResult =
  | { ok: true; transport: string }
  | { ok: false; code: AuthMailErrorCode; message: string; detail: string };

export interface AuthMailSender {
  readonly name: string;
  send(mail: AuthMail): Promise<AuthMailResult>;
}

/** German messages per F01 §5.9. */
export function authMailMessage(code: AuthMailErrorCode, detail = "", domain = ""): string {
  switch (code) {
    case "EMAIL_NOT_CONFIGURED":
      return "E-Mail-Versand ist nicht eingerichtet (Cloudflare-Zugang fehlt).";
    case "EMAIL_TOKEN_REJECTED":
      return "Cloudflare lehnt den API-Token ab (Berechtigung „Email Sending“ prüfen).";
    case "EMAIL_PLAN_REQUIRED":
      return "Ihr Cloudflare-Tarif erlaubt keinen Versand an diese Adresse (Workers Paid erforderlich oder Adresse verifizieren).";
    case "EMAIL_SENDING_DISABLED":
      return "Der Versand ist für die Absenderdomain deaktiviert. Bitte Cloudflare Email Service prüfen.";
    case "EMAIL_THROTTLED":
      return "Cloudflare drosselt den Versand. Bitte in einigen Minuten erneut versuchen.";
    case "EMAIL_SENDER_NOT_ONBOARDED":
      return `Die Absenderdomain ${domain} ist bei Cloudflare Email Service nicht eingerichtet.`;
    case "EMAIL_UNREACHABLE":
      return "Cloudflare ist nicht erreichbar. Ausgehende Verbindung des Servers prüfen.";
    case "EMAIL_ERROR":
      return `Versand fehlgeschlagen: ${detail}`;
  }
}

interface CloudflareError {
  code?: number;
  message?: string;
}

/** Maps a Cloudflare Email Sending response to our error code (F01 §5.9). */
export function mapCloudflareError(status: number, errors: CloudflareError[]): AuthMailErrorCode {
  const codes = new Set(errors.map((e) => e.code));
  const text = errors
    .map((e) => e.message ?? "")
    .join(" ")
    .toLowerCase();
  if (codes.has(10102) || status === 401 || status === 403) return "EMAIL_TOKEN_REJECTED";
  if (codes.has(10105)) return "EMAIL_PLAN_REQUIRED";
  if (codes.has(10203)) return "EMAIL_SENDING_DISABLED";
  if (codes.has(10004) || status === 429) return "EMAIL_THROTTLED";
  if (text.includes("onboard") || text.includes("not verified")) return "EMAIL_SENDER_NOT_ONBOARDED";
  return "EMAIL_ERROR";
}

/** Parses `AUTH_MAIL_FROM` (`noreply@mail.example.de` or `Name <noreply@mail.example.de>`). */
export function parseFrom(from: string, fallbackName: string): { address: string; name: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (m) return { name: m[1] || fallbackName, address: (m[2] as string).trim() };
  return { name: fallbackName, address: from.trim() };
}

const truncate = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function cloudflareSender(config: {
  accountId: string | undefined;
  apiToken: string | undefined;
  from: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): AuthMailSender {
  const doFetch = config.fetchImpl ?? fetch;
  return {
    name: "cloudflare",
    async send(mail) {
      if (!config.accountId || !config.apiToken || !config.from) {
        const code = "EMAIL_NOT_CONFIGURED";
        return {
          ok: false,
          code,
          message: authMailMessage(code),
          detail: "missing CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_EMAIL_API_TOKEN/AUTH_MAIL_FROM",
        };
      }
      const from = parseFrom(config.from, appName());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);
      try {
        const res = await doFetch(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/email/sending/send`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html }),
            signal: controller.signal,
          },
        );
        const body = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: CloudflareError[] };
        if (res.ok && body.success !== false) return { ok: true, transport: "cloudflare" };
        const errors = body.errors ?? [];
        const code = mapCloudflareError(res.status, errors);
        const detail = truncate(JSON.stringify(errors.length ? errors : { status: res.status }));
        return { ok: false, code, message: authMailMessage(code, detail, from.address.split("@")[1] ?? ""), detail };
      } catch (e) {
        const code = "EMAIL_UNREACHABLE";
        return { ok: false, code, message: authMailMessage(code), detail: truncate(String(e)) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Test/dev transport: hands every mail to `store` (the devMailbox table or an array). */
export function memorySender(store: (mail: AuthMail) => Promise<void>): AuthMailSender {
  return {
    name: "memory",
    async send(mail) {
      await store(mail);
      return { ok: true, transport: "memory" };
    },
  };
}

export function consoleSender(): AuthMailSender {
  return {
    name: "console",
    async send(mail) {
      console.info(`[auth-mail] to=${mail.to} kind=${mail.kind}\n${mail.subject}\n${mail.text}`);
      return { ok: true, transport: "console" };
    },
  };
}

export type AuthMailTransport = "cloudflare" | "memory" | "console";

export function configuredTransport(): AuthMailTransport {
  const t = env("AUTH_MAIL_SENDER");
  return t === "memory" || t === "console" ? t : "cloudflare";
}

export function senderFromEnv(store: (mail: AuthMail) => Promise<void>): AuthMailSender {
  switch (configuredTransport()) {
    case "memory":
      return memorySender(store);
    case "console":
      return consoleSender();
    default:
      return cloudflareSender({
        accountId: env("CLOUDFLARE_ACCOUNT_ID"),
        apiToken: env("CLOUDFLARE_EMAIL_API_TOKEN"),
        from: env("AUTH_MAIL_FROM"),
      });
  }
}
