/**
 * ZM rule data (F08 TAX-009, UVA-05; §18a UStG): the quarterly goods threshold above which the Zusammenfassende
 * Meldung must be filed monthly. Date-effective (CLAUDE.md rule 2).
 */
import type { Result } from "../result";
import type { CalendarDate } from "../time/calendar-date";
import { defineRuleTable, lookupRule, type RuleMissing, type RuleOverride, type RuleRow } from "./rule-table";

export interface ZmGoodsThreshold {
  readonly quarterlyGoodsLimitCents: number;
}

export const ZM_GOODS_THRESHOLD = defineRuleTable<ZmGoodsThreshold>("zm_goods_threshold", [
  {
    validFrom: "2012-01-01",
    value: { quarterlyGoodsLimitCents: 5_000_000 },
    source:
      "§ 18a Abs. 1 S. 2 UStG i. d. F. des Steuervereinfachungsgesetzes 2011 (BGBl. 2011 I S. 2131): 50.000 € je Quartal",
  },
]);

export const lookupZmGoodsThreshold = (
  date: CalendarDate,
  overrides: readonly RuleOverride<ZmGoodsThreshold>[] = [],
): Result<RuleRow<ZmGoodsThreshold>, RuleMissing> => lookupRule(ZM_GOODS_THRESHOLD, date, overrides);
