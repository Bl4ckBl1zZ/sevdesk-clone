import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import {
  bankConnectionOut,
  type ConnectionViewRecord,
  type RulePreviewRecord,
  type RuleRecord,
  ruleApplyArgs,
  ruleOut,
  rulePatchWire,
  rulePreviewOut,
  rulePreviewWire,
  ruleWhenArgs,
  ruleWire,
  serializeConnection,
  serializeRule,
  serializeRulePreview,
} from "@/domain/schemas/api/bank-feed";
import { voucherOut } from "@/domain/schemas/api/vouchers";
import type { ConvexCaller } from "../backend";
import { defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";
import { idParams, rawId } from "./shared";
import { voucherWire } from "./vouchers";

/**
 * F07 §7.1 Enable Banking connection status, the removed sync endpoint (BNK-107), matching rules (BNK-050…054) and
 * „+ Neuer Beleg“ from a transaction (BNK-065). Connecting, re-consent and fetching are owner-only in the UI: they
 * need the owner's bank login or presence (PSD2 PSU), so no API path exists for them.
 */

const TAG = "Bank und Kasse";

const invalidRef = () =>
  new ApiProblem("validation_failed", {
    errors: [{ code: "invalid", field: "when", message: "Unbekanntes Konto oder unbekannter Kontakt." }],
  });

export async function loadRule(convex: ConvexCaller, raw: string): Promise<RuleRecord> {
  const r = await convex.query(api.matchingRules.get, { id: raw as never }).catch((e: unknown) => {
    if (/ArgumentValidationError|Validator/.test(String(e))) return null;
    throw e;
  });
  if (!r) throw new ApiProblem("not_found", { detail: "Regel nicht gefunden." });
  return r as unknown as RuleRecord;
}

function ruleInput(body: Partial<z.infer<typeof ruleWire>>) {
  const when = body.when ? ruleWhenArgs(body.when) : undefined;
  const apply = body.apply ? ruleApplyArgs(body.apply) : undefined;
  if (when === null || apply === null) throw invalidRef();
  return {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.priority !== undefined ? { priority: body.priority } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.mode !== undefined ? { mode: body.mode } : {}),
    ...(when ? { when } : {}),
    ...(apply ? { apply } : {}),
  };
}

/** Shared by REST and MCP `matching_rule_upsert`: create, or patch when `id` is given (always `suggest`, BNK-054). */
export async function upsertRule(
  convex: ConvexCaller,
  id: string | undefined,
  body: Partial<z.infer<typeof ruleWire>>,
): Promise<z.infer<typeof ruleOut>> {
  const input = ruleInput(body);
  if (id) {
    await loadRule(convex, id);
    const r = await convex.mutation(api.matchingRules.update, { id: id as never, ...(input as object) } as never);
    return serializeRule(await loadRule(convex, id), r.warning);
  }
  const r = await convex.mutation(api.matchingRules.create, input as never);
  return serializeRule(await loadRule(convex, r.id), r.warning);
}

export const bankFeedResource = defineResource("bank-feed", "Bankanbindung und Regeln", [
  defineEndpoint({
    method: "GET",
    path: "/bank-connection",
    operationId: "getBankConnection",
    summary: "Status der Bankanbindung (Enable Banking)",
    description:
      "Zustimmungsstatus, Gültigkeit (`valid_until`, höchstens 180 Tage), gesendete Erinnerungen, letzter/nächster Abruf, Abrufbudget und Sperrzeit je Konto. Keine Geheimnisse (privater Schlüssel, Sitzung). Verbinden, Neu verbinden und „Jetzt abrufen“ gibt es nur in der Oberfläche (BNK-107).",
    tag: TAG,
    scope: "banking:read",
    response: { status: 200, schema: bankConnectionOut, description: "Die Verbindung" },
    handler: async ({ convex }) => ({
      body: serializeConnection((await convex.query(api.bankFeed.connection, {})) as unknown as ConnectionViewRecord),
    }),
  }),
  defineEndpoint({
    method: "POST",
    path: "/bank-accounts/{id}/sync",
    operationId: "syncBankAccount",
    summary: "Abruf auslösen (nicht möglich)",
    description:
      "Entfernt (BNK-107): Ein Abruf außerhalb der vier täglichen Hintergrundabrufe braucht den angemeldeten Inhaber (PSD2). Antwortet immer 409 `owner_presence_required`.",
    tag: TAG,
    scope: "banking:read",
    params: idParams("bankAccounts"),
    response: { status: 409, description: "Immer `owner_presence_required`" },
    errors: ["owner_presence_required"],
    handler: async () => {
      throw new ApiProblem("owner_presence_required");
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/matching-rules",
    operationId: "listMatchingRules",
    summary: "Zuordnungsregeln auflisten",
    description: "Nach Priorität (kleinste zuerst; die erste passende Regel gewinnt) mit Treffern der letzten 90 Tage.",
    tag: TAG,
    scope: "banking:read",
    response: {
      status: 200,
      schema: z.object({ data: z.array(ruleOut) }).meta({ id: "MatchingRuleList" }),
      description: "Die Regeln",
    },
    handler: async ({ convex }) => {
      const rows = (await convex.query(api.matchingRules.list, {})) as unknown as RuleRecord[];
      return { body: { data: rows.map((r) => serializeRule(r)) } };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/matching-rules",
    operationId: "createMatchingRule",
    summary: "Zuordnungsregel anlegen",
    description:
      "Wird immer als Vorschlagsregel (`mode: suggest`) gespeichert; die Automatik aktiviert der Inhaber in der Oberfläche (BNK-054, EC-BNK-73 – Hinweis in `warning`). Reguläre Ausdrücke müssen RE2-sicher sein (≤ 200 Zeichen).",
    tag: TAG,
    scope: "banking:write",
    body: ruleWire,
    response: { status: 201, schema: ruleOut, description: "Die Regel" },
    errors: ["validation_failed"],
    handler: async ({ convex, body }) => ({ status: 201, body: await upsertRule(convex, undefined, body) }),
  }),
  defineEndpoint({
    method: "POST",
    path: "/matching-rules/preview",
    operationId: "previewMatchingRule",
    summary: "Regel testen (ohne Wirkung)",
    description: "„Diese Regel würde n Umsätze der letzten 90 Tage treffen“ mit bis zu 50 Treffern (BNK-051).",
    tag: TAG,
    scope: "banking:read",
    body: rulePreviewWire,
    response: { status: 200, schema: rulePreviewOut, description: "Die Treffer" },
    errors: ["validation_failed"],
    handler: async ({ convex, body }) => {
      const when = ruleWhenArgs(body.when);
      if (!when) throw invalidRef();
      const p = await convex.query(api.matchingRules.preview, { when: when as never });
      return { body: serializeRulePreview(p as unknown as RulePreviewRecord) };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/matching-rules/{id}",
    operationId: "getMatchingRule",
    summary: "Zuordnungsregel abrufen",
    tag: TAG,
    scope: "banking:read",
    params: idParams("matchingRules"),
    response: { status: 200, schema: ruleOut, description: "Die Regel" },
    errors: ["not_found"],
    handler: async ({ convex, params }) => ({
      body: serializeRule(await loadRule(convex, rawId("matchingRules", params.id))),
    }),
  }),
  defineEndpoint({
    method: "PATCH",
    path: "/matching-rules/{id}",
    operationId: "updateMatchingRule",
    summary: "Zuordnungsregel ändern",
    description:
      "`mode: auto` ist über die API nicht möglich; eine Änderung von Bedingungen oder Aktion setzt eine automatische Regel auf `suggest` zurück (BNK-054).",
    tag: TAG,
    scope: "banking:write",
    params: idParams("matchingRules"),
    body: rulePatchWire,
    response: { status: 200, schema: ruleOut, description: "Die Regel" },
    errors: ["not_found", "validation_failed"],
    handler: async ({ convex, params, body }) => ({
      body: await upsertRule(convex, rawId("matchingRules", params.id), body),
    }),
  }),
  defineEndpoint({
    method: "POST",
    path: "/bank-transactions/{id}/voucher",
    operationId: "createVoucherFromBankTransaction",
    summary: "Beleg aus Bankumsatz anlegen",
    description:
      "Legt einen vorausgefüllten Belegentwurf an (Datum, Betrag, Gegenpartei, Verwendungszweck, Währung/Originalbetrag, Kontovorschlag aus dem Lieferantenprofil; BNK-065). Beim Fertigstellen wird der Umsatz zugeordnet. Ein vorhandener Entwurf zum Umsatz wird zurückgegeben.",
    tag: TAG,
    scope: "vouchers:write",
    params: idParams("bankTransactions"),
    body: z
      .object({ account: z.string().max(10).optional().meta({ description: "Sachkonto der Position" }) })
      .meta({ id: "BankTransactionVoucherRequest" }),
    response: { status: 201, schema: voucherOut, description: "Der Belegentwurf" },
    errors: ["not_found", "validation_failed"],
    handler: async ({ convex, params, body }) => {
      const id = await convex.mutation(api.matchingRules.createVoucherFromTransaction, {
        transactionId: rawId("bankTransactions", params.id) as never,
        ...(body.account ? { account: body.account } : {}),
      });
      return { status: 201, body: await voucherWire(convex, id) };
    },
  }),
]);
