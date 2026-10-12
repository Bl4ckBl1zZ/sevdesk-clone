/**
 * Shipped role → account mapping `roles-2026.2` (F08 §4.1.1, ACC-008). The posting matrix speaks only in roles;
 * this table turns them into SKR03/SKR04 numbers.
 *
 *  - rows with numbers are decided defaults and used as shipped;
 *  - `uncertain` rows (⚠ in F08 §4.1.1) are used as shipped and show a ⚠ badge (LEGAL-OPEN: F08-Q1);
 *  - `null` rows (UNSURE) ship **unmapped**: every posting that needs them is blocked until the owner maps the role
 *    (block rather than guess; TST-ACC-39).
 *
 * Parametric roles are not listed: `bank.<accountId>` (and `.fx`) resolve to the `bankAccounts` row's own ledger
 * account (03 §1, BNK-001); `clearing.<provider>` belongs to the deferred online payments (F10).
 * Owner overrides are stored in `accountRoleMappings` (append-only) and win from their `validFrom`.
 */
import type { RoleMappingRow } from "./types";

export const ROLE_MAPPING_VERSION = "roles-2026.2";

const r = (role: string, SKR03: string | null, SKR04: string | null, uncertain?: true): RoleMappingRow =>
  uncertain ? { role, SKR03, SKR04, uncertain } : { role, SKR03, SKR04 };
const W = true as const; // ⚠

export const ROLE_MAPPING_ROWS: readonly RoleMappingRow[] = [
  // finance
  r("cash", "1000", "1600"),
  r("transit", "1360", "1460"),
  r("receivable", "1400", "1200"),
  r("payable", "1600", "3300"),
  r("advance.received.19", "1718", "3272", W),
  r("advance.received.7", "1711", "3271", W),
  // VAT
  r("vat.output.19", "1776", "3806"),
  r("vat.output.7", "1771", "3801"),
  r("vat.output.notdue.19", "1766", "3816", W),
  r("vat.output.notdue.7", "1761", "3811", W),
  r("vat.input.19", "1576", "1406"),
  r("vat.input.7", "1571", "1401"),
  r("vat.input.notyet", null, null),
  r("vat.input.ige.19", "1574", "1404"),
  r("vat.input.ige.7", "1572", "1402"),
  r("vat.output.ige.19", "1774", "3804"),
  r("vat.output.ige.7", "1772", "3802"),
  r("vat.input.13b.19", "1577", "1407"),
  r("vat.output.13b.19", "1787", "3837"),
  r("vat.import", "1588", "1433"),
  r("vat.prepayment", "1780", "3820"),
  r("vat.special_prepayment", "1781", "3830"),
  r("vat.prior_year", "1790", "3841", W),
  // private / shareholder (ACC-028)
  r("private.withdrawal", "1800", "2100"),
  r("private.deposit", "1890", "2180"),
  r("private.taxes", "1810", "2150"),
  r("shareholder.clearing", null, null),
  // revenue
  r("revenue.domestic.19", "8400", "4400"),
  r("revenue.domestic.7", "8300", "4300"),
  r("revenue.zero_pv", null, null),
  r("revenue.icsupply", "8125", "4125"),
  r("revenue.export", "8120", "4120"),
  r("revenue.eu_service_rc", "8336", "4336"),
  r("revenue.13b_domestic", "8337", "4337"),
  r("revenue.not_taxable", "8338", "4338"),
  r("revenue.exempt_4", "8100", "4100"),
  r("revenue.ku", "8195", "4185"),
  r("revenue.withdrawal.19", "8910", "4620"),
  r("revenue.withdrawal.7", "8915", "4610"),
  // differences
  r("skonto.granted.19", "8736", "4736"),
  r("skonto.granted.7", "8731", "4731"),
  r("skonto.received.19", "3736", "5736"),
  r("skonto.received.7", "3731", "5731"),
  r("writeoff.19", "2406", "6936"),
  r("writeoff.7", "2401", "6931"),
  r("writeoff.0", "2400", "6930"),
  r("writeoff.recovery", "2732", "4925", W),
  r("income.interest_default", "2650", "7100"),
  r("income.other_nontaxable", "2700", "4830", W),
  // expenses
  r("expense.bank_fees", "4970", "6855"),
  r("expense.goods.19", "3400", "5400"),
  r("expense.goods.7", "3300", "5300"),
  r("expense.services", "3100", "5900"),
  r("expense.ige.19", "3425", "5425"),
  r("expense.ige.7", "3420", "5420"),
  r("expense.13b_eu.19", "3123", "5923", W),
  r("expense.13b_foreign.19", "3125", "5925", W),
  r("expense.13b_domestic.19", "3120", "5920", W),
  r("expense.entertainment", "4650", "6640"),
  r("expense.entertainment.nd", "4654", "6644"),
  r("expense.staff_events", "4140", "6130", W),
  r("expense.fx_loss", "2150", "6880"),
  r("income.fx_gain", "2660", "4840"),
  r("expense.trade_tax", "4320", "7610"),
  r("expense.corp_tax", "2200", "7600"),
  // assets and depreciation
  r("asset.office", "0420", "0650"),
  r("asset.vehicle", "0320", "0520"),
  r("asset.software", "0027", "0135"),
  r("asset.gwg", "0480", "0670"),
  r("asset.pool", "0485", "0675"),
  r("afa.tangible", "4830", "6220"),
  r("afa.vehicle", "4832", "6222"),
  r("afa.intangible", "4822", "6200"),
  r("afa.gwg", "4855", "6260"),
  r("afa.pool", "4862", "6264"),
  r("afa.extraordinary", "4840", "6230", W),
  r("disposal.rbw.loss", "2310", "6895"),
  r("disposal.rbw.gain", "2315", "4855"),
  r("disposal.proceeds.loss.19", "8801", "6885"),
  r("disposal.proceeds.gain.19", "8820", "4845"),
  // opening balances (ACC-013)
  r("opening.gl", "9000", "9000"),
  r("opening.debtors", "9008", "9008"),
  r("opening.creditors", "9009", "9009"),
];
