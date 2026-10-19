import "server-only";
import { z } from "zod";
import { ruleApplyWire, ruleWhenWire } from "@/domain/schemas/api/bank-feed";
import { prefixedId } from "@/domain/schemas/api/common";
import { ApiProblem } from "../../api/http";
import { upsertRule } from "../../api/resources/bank-feed";
import { rawId } from "../../api/resources/shared";
import { defineTool } from "../tool";

/**
 * 06 §3.7 `matching_rule_upsert` (F07 BNK-054, T07-085): rules from MCP are always stored as `suggest`; the owner
 * switches them to automatic in the app. There is no fetch/sync tool (BNK-107) and no tool that applies a rule to
 * existing transactions (that runs ⚠ actions — vouchers, Privat/Geldtransit — and is an explicit act in the UI).
 */
export const bankRuleTools = [
  defineTool({
    name: "matching_rule_upsert",
    title: "Zuordnungsregel anlegen/ändern",
    description:
      "Legt eine Bank-Zuordnungsregel an oder ändert sie (mit id mrl_…). Bedingungen in `when` (alle müssen zutreffen), Aktion in `apply` (categorize mit Sachkonto, private, transfer, link_contact, ignore, loan). Wird immer als Vorschlagsregel gespeichert; die Automatik aktiviert der Nutzer in der App. Erfinde keine Konten – frage nach.",
    kind: "write",
    scopes: ["banking:write"],
    input: z.object({
      id: prefixedId("matchingRules").optional(),
      name: z.string().min(1).max(120).optional(),
      priority: z.number().int().min(0).max(100_000).optional(),
      enabled: z.boolean().optional(),
      when: ruleWhenWire.optional(),
      apply: ruleApplyWire.optional(),
    }),
    handler: async ({ id, ...body }, { convex }) => {
      if (!id && (!body.name || !body.when || !body.apply)) {
        throw new ApiProblem("validation_failed", {
          detail: "Für eine neue Regel sind name, when und apply erforderlich.",
          errors: [{ code: "required", field: "when", message: "name, when und apply angeben" }],
        });
      }
      const input = id ? body : { priority: 100, enabled: true, ...body };
      return upsertRule(convex, id ? rawId("matchingRules", id) : undefined, input as never);
    },
  }),
];
