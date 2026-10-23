/**
 * F01 SET-136 (DSGVO-05): „Systeminfo kopieren“ — a redacted JSON for support: versions and health status only.
 * Whitelisted fields; free-text details are scrubbed of e-mail addresses, IBANs, URLs/hosts and token-like strings.
 * No secrets, no personal data, no business figures.
 */
export interface SystemInfoInput {
  readonly versions: Readonly<Record<string, unknown>>;
  readonly einvoice: Readonly<Record<string, unknown>> | null;
  readonly checks: readonly {
    readonly id: string;
    readonly status: string;
    readonly latencyMs?: number | undefined;
    readonly detail?: string | undefined;
  }[];
  readonly generatedAt: string;
}

const RULES: readonly [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[e-mail]"],
  [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g, "[iban]"],
  [/\bhttps?:\/\/\S+/gi, "[url]"],
  [/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, "[host]"],
  [/\b[A-Za-z0-9_\-+/=]{24,}\b/g, "[token]"],
];

export function redactText(s: string): string {
  return RULES.reduce((acc, [re, by]) => acc.replace(re, by), s).slice(0, 300);
}

const scalar = (v: unknown) =>
  typeof v === "string" ? redactText(v) : typeof v === "number" || typeof v === "boolean" || v === null ? v : undefined;

const flat = (o: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== null && typeof v === "object") out[k] = flat(v as Record<string, unknown>);
    else {
      const s = scalar(v);
      if (s !== undefined) out[k] = s;
    }
  }
  return out;
};

export function buildSystemInfo(i: SystemInfoInput): string {
  return JSON.stringify(
    {
      generatedAt: i.generatedAt,
      versions: flat(i.versions),
      einvoiceTools: i.einvoice ? flat(i.einvoice) : null,
      health: i.checks.map((c) => ({
        id: c.id,
        status: c.status,
        ...(c.latencyMs !== undefined ? { latencyMs: c.latencyMs } : {}),
        ...(c.detail ? { detail: redactText(c.detail) } : {}),
      })),
    },
    null,
    2,
  );
}
