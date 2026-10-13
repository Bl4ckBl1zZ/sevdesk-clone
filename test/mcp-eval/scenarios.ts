import type { Scope } from "../../src/domain/schemas/scopes";

/**
 * MCP eval scenarios (06 §7 "Eval (manual, P1 exit)"). Each scenario is a realistic German prompt for Claude Code
 * plus the reference tool calls a correct run makes. The reference calls are replayed automatically (in-process in
 * test/server/mcp-eval.test.ts, against a live endpoint with `pnpm mcp:eval`), so the scenarios stay valid while the
 * tools evolve; the prompt itself is run manually in Claude Code (`pnpm mcp:eval --list`).
 *
 * Arguments may reference earlier results: `"$<step>.<path>"`, e.g. `"$0.contact.id"`. Steps marked `setup` seed the
 * instance through the same tools. `forbidden` lists tools a correct run must not call (e.g. a ⚠ act without
 * approval).
 */
export interface EvalStep {
  tool: string;
  args: Record<string, unknown>;
  setup?: true;
  /** Represents the owner's explicit approval in the conversation before this ⚠ step. */
  afterApproval?: true;
  expect?: { isError?: boolean; equals?: Record<string, unknown> };
}

export interface EvalScenario {
  id: string;
  prompt: string;
  scopes: readonly Scope[];
  steps: readonly EvalStep[];
  forbidden?: readonly string[];
  success: string;
}

const RW: readonly Scope[] = ["contacts:read", "contacts:write", "products:read", "products:write", "settings:read"];

export const SCENARIOS: readonly EvalScenario[] = [
  {
    id: "EVAL-C01",
    prompt: "Leg die Müller GmbH aus Köln als Kunden an, Rechnungen bitte an rechnung@mueller.example.",
    scopes: RW,
    steps: [
      { tool: "contact_search", args: { query: "Müller" } },
      {
        tool: "contact_upsert",
        args: {
          contact: {
            kind: "organization",
            organization_name: "Müller GmbH",
            roles: ["customer"],
            billing_address: { city: "Köln", postal_code: "50667", street: "Domstraße 1", country_code: "DE" },
            channels: [{ type: "email", value: "rechnung@mueller.example", is_invoice_email: true }],
          },
        },
        expect: { equals: { matched_existing: false, "contact.organization_name": "Müller GmbH" } },
      },
    ],
    forbidden: ["contact_merge"],
    success: "Genau ein Kontakt Müller GmbH mit Rechnungs-E-Mail; keine erfundene USt-IdNr.",
  },
  {
    id: "EVAL-C02",
    prompt:
      "Die Müller GmbH hat sich nochmal über die Website gemeldet (rechnung@mueller.example) – bitte nicht doppelt anlegen.",
    scopes: RW,
    steps: [
      {
        tool: "contact_upsert",
        setup: true,
        args: {
          contact: {
            kind: "organization",
            organization_name: "Müller GmbH",
            channels: [{ type: "email", value: "rechnung@mueller.example" }],
          },
        },
      },
      {
        tool: "contact_upsert",
        args: {
          contact: {
            kind: "organization",
            organization_name: "Müller GmbH",
            channels: [{ type: "email", value: "rechnung@mueller.example" }],
          },
        },
        expect: { equals: { matched_existing: true, matched_by: "email" } },
      },
    ],
    success: "Der vorhandene Kontakt wird erkannt (matched_existing), keine Dublette.",
  },
  {
    id: "EVAL-C03",
    prompt: "Alpha GmbH ist doppelt angelegt. Führ die beiden bitte zusammen.",
    scopes: RW,
    steps: [
      {
        tool: "contact_upsert",
        setup: true,
        args: { contact: { kind: "organization", organization_name: "Alpha GmbH", number: "EV-1" } },
      },
      {
        tool: "contact_upsert",
        setup: true,
        args: { contact: { kind: "organization", organization_name: "Alpha G.m.b.H.", number: "EV-2" } },
      },
      { tool: "contact_find_duplicates", args: {} },
      {
        tool: "preview_action",
        args: { action: "contact_merge", params: { winner_id: "$0.contact.id", loser_ids: ["$1.contact.id"] } },
      },
      {
        tool: "contact_merge",
        afterApproval: true,
        args: { winner_id: "$0.contact.id", loser_ids: ["$1.contact.id"], confirm_token: "$3.confirm_token" },
        expect: { equals: { "winner.id": "$0.contact.id" } },
      },
    ],
    success: "Vorschau gezeigt, Freigabe eingeholt, erst dann contact_merge mit Token; ein Kontakt bleibt.",
  },
  {
    id: "EVAL-P01",
    prompt: "Leg die Leistung „Workshop-Tag“ für 1.200 € netto pro Tag an.",
    scopes: RW,
    steps: [
      { tool: "product_search", args: { query: "Workshop" } },
      {
        tool: "product_upsert",
        args: { product: { name: "Workshop-Tag", unit_price: "1200.00", unit_code: "DAY", price_mode: "net" } },
        expect: { equals: { created: true, "product.price.unit_price": "1200.0000" } },
      },
    ],
    success: "Ein Produkt mit 1.200,00 € netto je Tag (DAY), Steuerschlüssel standard.",
  },
  {
    id: "EVAL-P02",
    prompt: "Was kostet ein Workshop-Tag für die Beispiel AG brutto?",
    scopes: RW,
    steps: [
      {
        tool: "product_upsert",
        setup: true,
        args: { product: { name: "Workshop-Tag", unit_price: "1200.00", unit_code: "DAY" } },
      },
      {
        tool: "contact_upsert",
        setup: true,
        args: { contact: { kind: "organization", organization_name: "Beispiel AG" } },
      },
      { tool: "product_search", args: { query: "Workshop" } },
      { tool: "contact_search", args: { query: "Beispiel" } },
      {
        tool: "product_resolve_price",
        args: { id: "$0.product.id", contact_id: "$1.contact.id", price_mode: "gross" },
        expect: { equals: { unit_price: "1428.0000", source: "base" } },
      },
    ],
    success: "Antwort 1.428,00 € brutto (19 %), Quelle Grundpreis; nichts wird verändert.",
  },
];
