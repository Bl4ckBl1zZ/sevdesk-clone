/**
 * All shipped rule tables (F01 SET-120 shows them under /einstellungen/regeln with source and validity).
 * Importing this module validates every table (defineRuleTable throws on inconsistent data).
 */
import { BASISZINSSATZ } from "./basiszinssatz";
import { EU_VAT_TERRITORY } from "./eu-vat-countries";
import { EXEMPTION_REASONS } from "./exemption-reasons";
import { NOTE_TEXTS } from "./note-texts";
import { RC13B_TYPES } from "./rc13b-types";
import type { RuleTable } from "./rule-table";
import { KLEINBETRAG_LIMIT, KLEINUNTERNEHMER_LIMITS, VERZUG_SURCHARGES } from "./thresholds";
import { VAT_RATE_KEYS } from "./vat-rates";

export const ALL_RULE_TABLES: readonly RuleTable<unknown>[] = [
  ...Object.values(VAT_RATE_KEYS),
  BASISZINSSATZ,
  VERZUG_SURCHARGES,
  KLEINUNTERNEHMER_LIMITS,
  KLEINBETRAG_LIMIT,
  ...Object.values(NOTE_TEXTS),
  EU_VAT_TERRITORY,
  ...Object.values(RC13B_TYPES),
  ...Object.values(EXEMPTION_REASONS),
];
