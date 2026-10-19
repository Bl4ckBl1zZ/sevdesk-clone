/**
 * All shipped rule tables (F01 SET-120 shows them under /einstellungen/regeln with source and validity).
 * Importing this module validates every table (defineRuleTable throws on inconsistent data).
 */
import { ACCOUNTING_RULE_TABLES } from "./accounting";
import { AFA_RULES } from "./afa";
import { BASISZINSSATZ } from "./basiszinssatz";
import { EINVOICE_OBLIGATION } from "./einvoice-obligation";
import { EU_VAT_TERRITORY } from "./eu-vat-countries";
import { EXEMPTION_REASONS } from "./exemption-reasons";
import { NOTE_TEXTS } from "./note-texts";
import { RC13B_TYPES } from "./rc13b-types";
import { RETENTION_YEARS } from "./retention";
import type { RuleTable } from "./rule-table";
import { ANNUAL_RETURN_DEADLINE, NEUGRUENDER_RULE, USTVA_PERIOD_LIMITS } from "./tax-filing";
import {
  ASSET_THRESHOLDS,
  BOOKKEEPING_DUTY_LIMITS,
  INVOICING_DEADLINE,
  IST_TAXATION_LIMIT,
  KLEINBETRAG_LIMIT,
  KLEINUNTERNEHMER_LIMITS,
  KU_WAIVER_RULES,
  OSS_THRESHOLD,
  PAYMENT_TERM_LIMITS,
  TIMELY_RECORDING,
  VERZUG_SURCHARGES,
} from "./thresholds";
import { VAT_RATE_KEYS } from "./vat-rates";
import { ZM_GOODS_THRESHOLD } from "./zm";

export const ALL_RULE_TABLES: readonly RuleTable<unknown>[] = [
  ...Object.values(VAT_RATE_KEYS),
  BASISZINSSATZ,
  VERZUG_SURCHARGES,
  PAYMENT_TERM_LIMITS,
  KLEINUNTERNEHMER_LIMITS,
  KLEINBETRAG_LIMIT,
  KU_WAIVER_RULES,
  OSS_THRESHOLD,
  BOOKKEEPING_DUTY_LIMITS,
  IST_TAXATION_LIMIT,
  TIMELY_RECORDING,
  RETENTION_YEARS,
  ASSET_THRESHOLDS,
  AFA_RULES,
  INVOICING_DEADLINE,
  EINVOICE_OBLIGATION,
  ...Object.values(NOTE_TEXTS),
  EU_VAT_TERRITORY,
  ...Object.values(RC13B_TYPES),
  ...Object.values(EXEMPTION_REASONS),
  ...ACCOUNTING_RULE_TABLES,
  USTVA_PERIOD_LIMITS,
  NEUGRUENDER_RULE,
  ANNUAL_RETURN_DEADLINE,
  ZM_GOODS_THRESHOLD,
];
