/**
 * RFC 9457 problem details (05 §3.1). One table of problem codes with HTTP status and German/English titles; the
 * mapping of Convex application errors (`{ code, message, reason?, issues? }`, convex/lib/errors.ts) to problems.
 * Codes are lower snake_case; the upper-case reason names of the feature specs (`UPSERT_AMBIGUOUS`,
 * `CONTACT_IN_USE`, …) appear lower-cased (05 §3.1 note).
 */
export type Lang = "de" | "en";

interface ProblemDef {
  status: number;
  de: string;
  en: string;
}

export const PROBLEMS = {
  bad_request: { status: 400, de: "Ungültige Anfrage.", en: "Bad request." },
  idempotency_key_required: {
    status: 400,
    de: "Für diese Aktion ist ein Idempotency-Key erforderlich.",
    en: "This action requires an Idempotency-Key.",
  },
  key_in_query_not_allowed: {
    status: 400,
    de: "API-Schlüssel dürfen nicht in der URL übergeben werden.",
    en: "API keys must not be sent in the query string.",
  },
  invalid_expand: { status: 400, de: "Unbekannter Wert für expand.", en: "Unknown expand value." },
  unauthorized: {
    status: 401,
    de: "API-Schlüssel fehlt, ist ungültig, abgelaufen oder widerrufen.",
    en: "The API key is missing, invalid, expired or revoked.",
  },
  insufficient_scope: {
    status: 403,
    de: "Der API-Schlüssel hat nicht die nötige Berechtigung.",
    en: "The API key lacks the required scope.",
  },
  owner_only: {
    status: 403,
    de: "Diese Einstellung kann nur die Inhaberin bzw. der Inhaber in der Oberfläche ändern.",
    en: "Only the owner can change this setting, in the UI.",
  },
  not_found: { status: 404, de: "Nicht gefunden.", en: "Not found." },
  method_not_allowed: { status: 405, de: "Methode nicht erlaubt.", en: "Method not allowed." },
  version_conflict: {
    status: 409,
    de: "Der Datensatz wurde zwischenzeitlich geändert.",
    en: "The record was changed in the meantime.",
  },
  immutable_record: {
    status: 409,
    de: "Dieser Datensatz ist unveränderlich (GoBD).",
    en: "This record is immutable (GoBD).",
  },
  period_locked: { status: 409, de: "Der Zeitraum ist festgeschrieben.", en: "The period is locked." },
  setup_incomplete: {
    status: 409,
    de: "Die Einrichtung ist noch nicht abgeschlossen.",
    en: "The setup is not complete.",
  },
  conflict: { status: 409, de: "Konflikt.", en: "Conflict." },
  upsert_ambiguous: {
    status: 409,
    de: "Mehrere vorhandene Kontakte passen – bitte eindeutig zuordnen.",
    en: "More than one existing contact matches.",
  },
  contact_in_use: {
    status: 409,
    de: "Der Kontakt wird noch verwendet und kann nur archiviert werden.",
    en: "The contact is still in use and can only be archived.",
  },
  contact_merged: {
    status: 409,
    de: "Der Kontakt wurde zusammengeführt.",
    en: "The contact was merged into another contact.",
  },
  product_in_use: {
    status: 409,
    de: "Das Produkt wird noch verwendet und kann nur archiviert werden.",
    en: "The product is still in use and can only be archived.",
  },
  number_collision: {
    status: 409,
    de: "Diese Nummer ist bereits vergeben.",
    en: "This number is already taken.",
  },
  // F04 §5.1.6 Storno and correction guards (INV-10/11/15, UST-30): German detail from the guard.
  storno_paid_invoice: {
    status: 409,
    de: "Die Rechnung ist (teil)bezahlt und kann nicht storniert werden.",
    en: "The invoice is (partially) paid and cannot be cancelled.",
  },
  already_cancelled: {
    status: 409,
    de: "Die Rechnung ist bereits storniert.",
    en: "The invoice is already cancelled.",
  },
  storno_of_storno: {
    status: 409,
    de: "Eine Stornorechnung kann nicht storniert werden.",
    en: "A cancellation invoice cannot be cancelled.",
  },
  storno_advance_deducted: {
    status: 409,
    de: "Die Abschlagsrechnung ist in einer Schlussrechnung verrechnet.",
    en: "The advance invoice is deducted in a final invoice.",
  },
  storno_has_corrections: {
    status: 409,
    de: "Zur Rechnung gibt es Rechnungskorrekturen.",
    en: "The invoice has credit corrections.",
  },
  correction_refund_allocated: {
    status: 409,
    de: "Die Rechnungskorrektur ist bereits erstattet oder verrechnet.",
    en: "The correction is already refunded or offset.",
  },
  correction_target_invalid: {
    status: 409,
    de: "Korrekturen sind nur zu fertiggestellten Rechnungen möglich.",
    en: "Corrections are only possible for finalised invoices.",
  },
  final_exists: {
    status: 409,
    de: "Für diesen Auftrag gibt es bereits eine Schlussrechnung.",
    en: "This order already has a final invoice.",
  },
  illegal_transition: {
    status: 409,
    de: "Diese Aktion ist im aktuellen Status nicht möglich.",
    en: "This action is not possible in the current status.",
  },
  idempotency_in_progress: {
    status: 409,
    de: "Eine Anfrage mit diesem Idempotency-Key wird gerade verarbeitet.",
    en: "A request with this Idempotency-Key is still being processed.",
  },
  unsupported_media_type: {
    status: 415,
    de: "Bitte JSON senden (application/json).",
    en: "Please send JSON (application/json).",
  },
  validation_failed: {
    status: 422,
    de: "Die Eingaben sind nicht gültig.",
    en: "The request failed validation.",
  },
  idempotency_key_reused: {
    status: 422,
    de: "Dieser Idempotency-Key wurde bereits für eine andere Anfrage verwendet.",
    en: "This Idempotency-Key was already used for a different request.",
  },
  rate_limited: {
    status: 429,
    de: "Zu viele Anfragen – bitte später erneut versuchen.",
    en: "Too many requests – please retry later.",
  },
  internal_error: { status: 500, de: "Interner Fehler.", en: "Internal error." },
  /** A catalog entry whose feature has not shipped yet (e.g. document previews before F04). */
  not_implemented: {
    status: 501,
    de: "Diese Funktion ist in dieser Version noch nicht verfügbar.",
    en: "This function is not available in this version yet.",
  },
  dependency_unavailable: {
    status: 503,
    de: "Ein benötigter Dienst ist nicht erreichbar.",
    en: "A required service is unavailable.",
  },
} as const satisfies Record<string, ProblemDef>;

export type ProblemCode = keyof typeof PROBLEMS;

export interface ProblemFieldError {
  code: string;
  field?: string;
  rule?: string;
  message: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  request_id: string;
  detail?: string;
  errors?: ProblemFieldError[];
  warnings?: ProblemFieldError[];
  required_scope?: string;
  [extra: string]: unknown;
}

export function preferredLang(acceptLanguage: string | null | undefined): Lang {
  if (!acceptLanguage) return "de";
  const first = acceptLanguage
    .split(",")
    .map((p) => {
      const [tag = "", q = "q=1"] = p.trim().split(";");
      return { tag: tag.toLowerCase(), q: Number(q.replace(/^q=/, "")) || 0 };
    })
    .sort((a, b) => b.q - a.q)[0];
  return first?.tag.startsWith("en") ? "en" : "de";
}

export function problem(
  code: ProblemCode,
  opts: {
    requestId: string;
    lang?: Lang;
    typeBase: string;
    detail?: string;
    errors?: ProblemFieldError[];
    extra?: Record<string, unknown>;
  },
): Problem {
  const def = PROBLEMS[code];
  return {
    type: `${opts.typeBase.replace(/\/$/, "")}/problems/${code}`,
    title: def[opts.lang ?? "de"],
    status: def.status,
    code,
    request_id: opts.requestId,
    ...(opts.detail ? { detail: opts.detail } : {}),
    ...(opts.errors && opts.errors.length > 0 ? { errors: opts.errors } : {}),
    ...(opts.extra ?? {}),
  };
}

// ── mapping Convex application errors ────────────────────────────────────────────────────────────────
export interface AppErrorData {
  code: string;
  message?: string;
  reason?: string;
  field?: string;
  issues?: { path: string; message: string }[];
  permission?: string;
  [k: string]: unknown;
}

/** Reasons of `invalid_input` errors that are state conflicts (409), not input errors (422). */
const CONFLICT_REASONS: Readonly<Record<string, ProblemCode>> = {
  UPSERT_AMBIGUOUS: "upsert_ambiguous",
  CONTACT_IN_USE: "contact_in_use",
  CONTACT_MERGED: "contact_merged",
  PRODUCT_IN_USE: "product_in_use",
  // F04 Storno/correction guards (convex/model/invoiceCorrections.ts: `conflict` with the guard code as reason).
  storno_paid_invoice: "storno_paid_invoice",
  already_cancelled: "already_cancelled",
  storno_of_storno: "storno_of_storno",
  storno_advance_deducted: "storno_advance_deducted",
  storno_has_corrections: "storno_has_corrections",
  correction_refund_allocated: "correction_refund_allocated",
  correction_target_invalid: "correction_target_invalid",
  final_exists: "final_exists",
  illegal_transition: "illegal_transition",
  NUMBER_COLLISION: "number_collision",
};

const APP_CODE_TO_PROBLEM: Readonly<Record<string, ProblemCode>> = {
  unauthenticated: "unauthorized",
  session_invalid: "unauthorized",
  key_revoked: "unauthorized",
  not_a_member: "unauthorized",
  member_expired: "unauthorized",
  member_disabled: "unauthorized",
  forbidden_scope: "insufficient_scope",
  forbidden_role: "insufficient_scope",
  not_found: "not_found",
  version_conflict: "version_conflict",
  immutable_record: "immutable_record",
  period_locked: "period_locked",
  setup_incomplete: "setup_incomplete",
  conflict: "conflict",
  illegal_transition: "illegal_transition",
  document_not_draft: "immutable_record",
  dependency_unavailable: "dependency_unavailable",
  not_configured: "dependency_unavailable",
  invalid_input: "validation_failed",
  idempotency_key_reused: "idempotency_key_reused",
  idempotency_in_progress: "idempotency_in_progress",
};

export interface MappedProblem {
  code: ProblemCode;
  errors: ProblemFieldError[];
  detail?: string;
  /** Spec-level code to expose when it is more specific than the problem code (e.g. a reason). */
  extra: Record<string, unknown>;
}

/** Field path of the form schema → wire path (snake_case, `[i]` for array positions). */
export type FieldMapper = (path: string) => string | undefined;

export function snakeCase(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Default mapper: `billingAddress.countryCode` → `billing_address.country_code`, `channels.0.value` → `channels[0].value`. */
export const defaultFieldMapper: FieldMapper = (path) => {
  if (!path) return undefined;
  return path
    .split(".")
    .map((s) => (/^\d+$/.test(s) ? `[${s}]` : snakeCase(s)))
    .join(".")
    .replace(/\.\[/g, "[");
};

export function mapAppError(
  data: AppErrorData,
  opts: { fieldMapper?: FieldMapper; scopeForPermission?: (p: string) => string | null } = {},
): MappedProblem {
  const fieldMapper = opts.fieldMapper ?? defaultFieldMapper;
  const reason = typeof data.reason === "string" ? data.reason : undefined;
  if (reason && CONFLICT_REASONS[reason]) {
    return { code: CONFLICT_REASONS[reason], errors: [], ...(data.message ? { detail: data.message } : {}), extra: {} };
  }
  const code = APP_CODE_TO_PROBLEM[data.code] ?? "bad_request";
  const extra: Record<string, unknown> = {};
  if (code === "insufficient_scope" && data.permission && opts.scopeForPermission) {
    const scope = opts.scopeForPermission(data.permission);
    if (scope) extra.required_scope = scope;
  }
  if (code !== "validation_failed") {
    return { code, errors: [], ...(data.message ? { detail: data.message } : {}), extra };
  }
  const errorCode = (reason ?? "invalid").toLowerCase();
  const errors: ProblemFieldError[] =
    data.issues && data.issues.length > 0
      ? data.issues.map((i, n) => {
          const field = fieldMapper(i.path);
          return {
            code: n === 0 ? errorCode : "invalid",
            ...(field ? { field } : {}),
            message: i.message,
          };
        })
      : [
          {
            code: errorCode,
            ...(data.field ? { field: fieldMapper(data.field) ?? data.field } : {}),
            message: data.message ?? PROBLEMS.validation_failed.de,
          },
        ];
  return { code, errors, extra };
}
