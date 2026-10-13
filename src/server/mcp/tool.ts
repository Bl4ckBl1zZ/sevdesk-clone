import "server-only";
import { z } from "zod";
import { scopeFor } from "@/domain/access/permissions";
import type { ConfirmIntent } from "@/domain/api/confirm";
import { CONFIRM_TOKEN_MESSAGES } from "@/domain/api/confirm";
import { type FieldMapper, mapAppError, PROBLEMS } from "@/domain/api/problems";
import type { Scope } from "@/domain/schemas/scopes";
import type { KeyInfo } from "../api/auth";
import type { ConvexCaller, Principal } from "../api/backend";
import { ApiProblem, appErrorData } from "../api/http";

/**
 * MCP tool registration (06 §2/§3, CLAUDE.md rule 8). Every tool declares its kind; the helper derives the
 * annotations so they can never drift from the safety model:
 *
 * - `read`   → readOnlyHint: true
 * - `write`  → readOnlyHint: false, destructiveHint: false (drafts, master data; reversible)
 * - `danger` → ⚠ legally relevant: destructiveHint: true, `_meta["anthropic/requiresUserInteraction"]: true`, a
 *   required `confirm_token` argument and a `confirmIntent` that the Convex mutation wrapper enforces (EC-188).
 *
 * Tools are listed only for keys holding one of their scopes (06 §2.1); Convex re-checks every call.
 */
export type ToolKind = "read" | "write" | "danger";

export const REQUIRES_USER_INTERACTION = "anthropic/requiresUserInteraction";

export interface ToolContext {
  convex: ConvexCaller;
  principal: Principal;
  key: KeyInfo;
}

export interface ToolDef<I extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  /** The key needs one of these scopes for the tool to be listed (`any read` = all read scopes). */
  scopes: readonly Scope[];
  input: I;
  /** ⚠ tools only: the intent whose confirm token the guarded mutation consumes (06 §2.3). */
  confirmIntent?: ConfirmIntent;
  /** W tools that still need an explicit approval (e.g. a legal consent record, 06 §3.2). */
  requiresUserInteraction?: boolean;
  openWorld?: boolean;
  idempotent?: boolean;
  fieldMapper?: FieldMapper;
  handler: (args: z.output<I>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}

export interface RegisteredToolDef extends ToolDef {
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  meta: Record<string, unknown>;
}

const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

export const confirmTokenArg = z
  .string()
  .min(1)
  .max(200)
  .meta({ description: "Token aus der Vorschau (preview_action / document_preview / dunning_preview), 10 min gültig" });

export function defineTool<I extends z.ZodObject>(def: ToolDef<I>): RegisteredToolDef {
  if (!NAME_RE.test(def.name)) throw new Error(`MCP tool ${def.name}: invalid name`);
  if (def.scopes.length === 0) throw new Error(`MCP tool ${def.name}: needs at least one scope`);
  if (def.description.length > 1024) throw new Error(`MCP tool ${def.name}: description too long`);
  const danger = def.kind === "danger";
  if (danger !== (def.confirmIntent !== undefined)) {
    throw new Error(`MCP tool ${def.name}: ⚠ tools and only ⚠ tools declare a confirmIntent (06 §2.1)`);
  }
  if (danger && !(def.input.shape as Record<string, unknown>).confirm_token) {
    throw new Error(`MCP tool ${def.name}: ⚠ tools need a required confirm_token argument (06 §2.3)`);
  }
  if (danger && def.input.safeParse({}).success) {
    throw new Error(`MCP tool ${def.name}: confirm_token must be required`);
  }
  return {
    ...(def as unknown as ToolDef),
    annotations: {
      readOnlyHint: def.kind === "read",
      destructiveHint: danger,
      idempotentHint: def.idempotent ?? def.kind === "read",
      openWorldHint: def.openWorld ?? false,
    },
    meta: danger || def.requiresUserInteraction ? { [REQUIRES_USER_INTERACTION]: true } : {},
  };
}

export function toolVisible(tool: RegisteredToolDef, scopes: readonly string[]): boolean {
  return tool.scopes.some((s) => scopes.includes(s));
}

// ── results ──────────────────────────────────────────────────────────────────────────────────────────
export function toolResult(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
}

const CONFIRM_CODES = new Set(Object.keys(CONFIRM_TOKEN_MESSAGES));

const HINTS: Readonly<Record<string, string>> = {
  confirm_token_required: "Zuerst preview_action mit derselben action und denselben params aufrufen.",
  confirm_token_expired: "Vorschau erneut aufrufen (Token 10 Minuten gültig).",
  confirm_token_used: "Für jede Ausführung eine neue Vorschau holen.",
  preview_outdated: "Die Daten haben sich seit der Vorschau geändert: Vorschau erneut aufrufen und bestätigen lassen.",
  confirm_token_intent_mismatch: "Das Token gehört zu einer anderen Aktion.",
  insufficient_scope:
    "Der Schlüssel hat diese Berechtigung nicht; der Inhaber kann sie unter Einstellungen › API erteilen.",
  version_conflict: "Datensatz neu laden (…_get) und die Änderung erneut senden.",
  upsert_ambiguous: "Mehrere Kontakte passen: den Nutzer fragen, welcher gemeint ist, und mit der ID aktualisieren.",
};

/** Errors → `isError: true` with the same codes and fields as REST plus a German hint (06 §2.6). */
export function toolError(e: unknown, fieldMapper?: FieldMapper) {
  let error: Record<string, unknown>;
  if (e instanceof ApiProblem) {
    error = {
      code: e.code,
      message: e.opts.detail ?? PROBLEMS[e.code].de,
      ...(e.opts.errors ? { errors: e.opts.errors } : {}),
    };
  } else {
    const data = appErrorData(e);
    if (data && CONFIRM_CODES.has(data.code)) {
      error = { code: data.code, message: data.message ?? CONFIRM_TOKEN_MESSAGES[data.code as never] };
    } else if (data) {
      const mapped = mapAppError(data, {
        ...(fieldMapper ? { fieldMapper } : {}),
        scopeForPermission: (p) => scopeFor(p as never),
      });
      error = {
        code: mapped.code,
        message: mapped.detail ?? data.message ?? PROBLEMS[mapped.code].de,
        ...(mapped.errors.length > 0 ? { errors: mapped.errors } : {}),
        ...mapped.extra,
      };
    } else {
      console.error("MCP: unexpected tool error", e);
      error = { code: "internal_error", message: PROBLEMS.internal_error.de };
    }
  }
  const hint = HINTS[String(error.code)];
  const body = { error: { ...error, ...(hint ? { hint } : {}) } };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}
