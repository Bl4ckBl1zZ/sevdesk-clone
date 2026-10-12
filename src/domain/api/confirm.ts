import { canonicalize } from "../audit/canonical";
import { sha256Hex } from "../audit/chain";

/**
 * Confirmation tokens for legally relevant (⚠) MCP tools (06 §2.3, CLAUDE.md rule 8, EC-003, EC-188).
 *
 * A preview (`document_preview`, `dunning_preview`, `preview_action`) issues a token for an **intent** — the name of
 * the ⚠ tool it unlocks (`document_finalize`, `invoice_cancel`, `dunning_run`, `contact_merge`, …). The token is
 * bound to the API key, the intent, the SHA-256 of the canonical arguments of the guarded Convex mutation and the
 * `version` of every previewed entity; it is valid for 10 minutes and single use. Convex consumes it in the same
 * transaction as the act, so a failed act does not burn it and two concurrent calls cannot both succeed.
 */
export const CONFIRM_TOKEN_TTL_MS = 10 * 60_000;
export const CONFIRM_TOKEN_PREFIX = "ct_";

/** ⚠ intents (06 §2.1) and the preview that issues them. Later slices add rows; the wrapper enforces them. */
export const CONFIRM_INTENTS = {
  document_finalize: "document_preview",
  invoice_cancel: "document_preview",
  dunning_run: "dunning_preview",
  document_mark_sent: "preview_action",
  payment_record: "preview_action",
  payment_reverse: "preview_action",
  bank_match_confirm: "preview_action",
  bank_transaction_mark: "preview_action",
  bank_statement_import: "preview_action",
  cash_transfer_record: "preview_action",
  voucher_finalize: "preview_action",
  contact_merge: "preview_action",
  export_datev: "preview_action",
} as const;

export type ConfirmIntent = keyof typeof CONFIRM_INTENTS;
export type ConfirmIssuer = (typeof CONFIRM_INTENTS)[ConfirmIntent];

export function isConfirmIntent(value: string): value is ConfirmIntent {
  return value in CONFIRM_INTENTS;
}

/** `document_preview` with `intent: "finalize" | "cancel"` → the ⚠ tool it unlocks (06 §3.4). */
export function documentPreviewIntent(intent: "finalize" | "cancel"): ConfirmIntent {
  return intent === "cancel" ? "invoice_cancel" : "document_finalize";
}

/** SHA-256 over the canonical JSON (RFC 8785) of the guarded mutation's arguments (without `confirmToken`). */
export function confirmParamsHash(args: Record<string, unknown>): Promise<string> {
  const { confirmToken: _ignored, ...rest } = args;
  return sha256Hex(canonicalize(rest));
}

export interface EntityVersion {
  table: string;
  id: string;
  /** `version` field at preview time; null for records without a version (existence is still checked). */
  version: number | null;
}

export interface StoredConfirmToken {
  keyId: string;
  intent: string;
  paramsHash: string;
  entities: readonly EntityVersion[];
  expiresAt: number;
  usedAt?: number;
}

export type ConfirmTokenError =
  | "confirm_token_required"
  | "confirm_token_invalid"
  | "confirm_token_expired"
  | "confirm_token_used"
  | "confirm_token_intent_mismatch"
  | "preview_outdated";

export const CONFIRM_TOKEN_MESSAGES: Readonly<Record<ConfirmTokenError, string>> = {
  confirm_token_required:
    "Für diese Aktion ist ein confirm_token aus der Vorschau nötig (document_preview, dunning_preview oder preview_action).",
  confirm_token_invalid: "Der confirm_token ist ungültig. Bitte die Vorschau erneut aufrufen.",
  confirm_token_expired: "Der confirm_token ist abgelaufen (10 Minuten). Bitte die Vorschau erneut aufrufen.",
  confirm_token_used: "Der confirm_token wurde bereits verwendet. Bitte die Vorschau erneut aufrufen.",
  confirm_token_intent_mismatch: "Der confirm_token gehört zu einer anderen Aktion.",
  preview_outdated:
    "Die Daten oder Parameter haben sich seit der Vorschau geändert. Bitte die Vorschau erneut aufrufen.",
};

/**
 * Decides whether `stored` authorises the act. `current` maps `table:id` to the entity's current version
 * (undefined = record gone). Order: missing/unknown → key → used → expired → intent → params → versions.
 */
export function checkConfirmToken(
  stored: StoredConfirmToken | null,
  call: {
    keyId: string;
    intent: string;
    paramsHash: string;
    now: number;
    current: ReadonlyMap<string, number | null | undefined>;
  },
): ConfirmTokenError | null {
  if (!stored || stored.keyId !== call.keyId) return "confirm_token_invalid";
  if (stored.usedAt !== undefined) return "confirm_token_used";
  if (stored.expiresAt <= call.now) return "confirm_token_expired";
  if (stored.intent !== call.intent) return "confirm_token_intent_mismatch";
  if (stored.paramsHash !== call.paramsHash) return "preview_outdated";
  for (const e of stored.entities) {
    const now = call.current.get(`${e.table}:${e.id}`);
    if (now === undefined || now !== e.version) return "preview_outdated";
  }
  return null;
}
