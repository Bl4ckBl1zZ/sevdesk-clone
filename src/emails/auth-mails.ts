/**
 * German auth-mail texts (02 §9, F01 §4.6). Plain functions, no React: used by the Convex auth-mail action.
 * The app never e-mails customers — only sign-in codes, invitations and owner notifications.
 */
export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function layout(title: string, paragraphs: string[]): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join("");
  return (
    '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>' +
    escapeHtml(title) +
    '</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">' +
    body +
    '<p style="margin:24px 0 0;color:#666;font-size:12px">Diese Nachricht wurde automatisch versendet. Bitte nicht antworten.</p>' +
    "</body></html>"
  );
}

export type OtpPurpose = "sign-in" | "email-verification" | "forget-password" | "change-email";

/** Sign-in code (Better Auth emailOTP `sendVerificationOTP`). Valid for `validMinutes` (default 10). */
export function otpMail(input: {
  code: string;
  appName: string;
  validMinutes?: number;
  purpose?: OtpPurpose;
}): MailContent {
  const minutes = input.validMinutes ?? 10;
  const subject = `Ihr Anmeldecode für ${input.appName}: ${input.code}`;
  const lines = [
    "Guten Tag,",
    `Ihr Anmeldecode lautet: ${input.code}`,
    `Der Code ist ${minutes} Minuten gültig und kann nur einmal verwendet werden.`,
    "Falls Sie keine Anmeldung angefordert haben, können Sie diese Nachricht ignorieren.",
  ];
  return {
    subject,
    text: lines.join("\n\n"),
    html: layout(subject, [
      escapeHtml(lines[0] as string),
      `Ihr Anmeldecode lautet:<br><strong style="font-size:28px;letter-spacing:4px">${escapeHtml(input.code)}</strong>`,
      escapeHtml(lines[2] as string),
      escapeHtml(lines[3] as string),
    ]),
  };
}

const ROLE_DE = { bookkeeper: "Buchhaltung", viewer: "Lesezugriff", auditor: "Prüfer (nur Lesen)" } as const;

/** Invitation (02 §4.3). The link opens only inside the tailnet. */
export function inviteMail(input: {
  appName: string;
  companyName: string;
  role: keyof typeof ROLE_DE;
  signInUrl: string;
  expiresOn: string;
}): MailContent {
  const subject = `Einladung zu ${input.appName} (${input.companyName})`;
  const lines = [
    "Guten Tag,",
    `Sie wurden zu ${input.appName} von ${input.companyName} eingeladen (Rolle: ${ROLE_DE[input.role]}).`,
    `Melden Sie sich bis zum ${input.expiresOn} mit dieser E-Mail-Adresse an: ${input.signInUrl}`,
    "Sie erhalten bei der Anmeldung einen Code per E-Mail. Die Anwendung ist nur aus dem freigegebenen Netzwerk (Tailnet) erreichbar.",
  ];
  return {
    subject,
    text: lines.join("\n\n"),
    html: layout(subject, [
      escapeHtml(lines[0] as string),
      escapeHtml(lines[1] as string),
      `Melden Sie sich bis zum ${escapeHtml(input.expiresOn)} mit dieser E-Mail-Adresse an: <a href="${escapeHtml(input.signInUrl)}">${escapeHtml(input.signInUrl)}</a>`,
      escapeHtml(lines[3] as string),
    ]),
  };
}

/** „Test-Code senden" (F01 SET-107). */
export function testMail(input: { appName: string; companyName: string }): MailContent {
  const subject = `Testnachricht von ${input.companyName}`;
  const text = `Diese Testnachricht bestätigt, dass ${input.appName} Anmelde-E-Mails über Cloudflare versenden kann.`;
  return { subject, text, html: layout(subject, [escapeHtml(text)]) };
}
