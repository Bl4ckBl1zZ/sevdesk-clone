/**
 * Built-in keyword → expense account table for voucher suggestions (F06 VOU-041 step 3, confidence 0.6).
 *
 * Rule data, not logic: each row maps supplier/description keywords to the account of each chart. The numbers are
 * the standard DATEV accounts already seeded in `src/domain/rules/accounting/skr03.ts` / `skr04.ts`
 * (LEGAL-OPEN: F08-Q1 — `verified: false` accounts of the seed carry the same caveat).
 */
import type { Chart } from "../rules/accounting";

export interface KeywordRow {
  /** Lowercase substrings matched against the normalised supplier name and the line descriptions. */
  keywords: readonly string[];
  label: string;
  accounts: Readonly<Record<Chart, string>>;
}

export const EXPENSE_KEYWORDS: readonly KeywordRow[] = [
  {
    keywords: ["telekom", "vodafone", "o2 ", "telefonica", "1&1", "congstar", "mobilfunk"],
    label: "Telefon",
    accounts: { SKR03: "4920", SKR04: "6805" },
  },
  {
    keywords: [
      "tankstelle",
      "aral",
      "shell",
      "esso",
      "jet ",
      "totalenergies",
      "agip",
      "kraftstoff",
      "diesel",
      "benzin",
    ],
    label: "Kraftstoff (laufende Kfz-Betriebskosten)",
    accounts: { SKR03: "4530", SKR04: "6530" },
  },
  {
    keywords: ["deutsche bahn", "db fernverkehr", "bahn", "flixbus", "lufthansa", "taxi", "uber"],
    label: "Reisekosten (Fahrtkosten)",
    accounts: { SKR03: "4673", SKR04: "6673" },
  },
  {
    keywords: ["google ads", "google ireland", "meta platforms", "facebook", "linkedin ads", "werbung"],
    label: "Werbekosten",
    accounts: { SKR03: "4600", SKR04: "6600" },
  },
  {
    keywords: ["hotel", "übernachtung", "uebernachtung", "booking.com", "airbnb"],
    label: "Reisekosten (Übernachtung)",
    accounts: { SKR03: "4676", SKR04: "6680" },
  },
  {
    keywords: ["deutsche post", "dhl", "porto", "briefmarke"],
    label: "Porto",
    accounts: { SKR03: "4910", SKR04: "6800" },
  },
  {
    keywords: ["hosting", "hetzner", "ionos", "strato", "internet", "cloudflare"],
    label: "Internetkosten",
    accounts: { SKR03: "4925", SKR04: "6810" },
  },
  {
    keywords: ["software", "lizenz", "adobe", "microsoft", "github", "atlassian", "jetbrains", "anthropic", "openai"],
    label: "Software/Lizenzen",
    accounts: { SKR03: "4964", SKR04: "6837" },
  },
  {
    keywords: ["bürobedarf", "buerobedarf", "papier", "toner", "staples", "viking"],
    label: "Bürobedarf",
    accounts: { SKR03: "4930", SKR04: "6815" },
  },
  {
    keywords: ["versicherung", "allianz", "huk", "axa", "ergo"],
    label: "Versicherungen",
    accounts: { SKR03: "4360", SKR04: "6400" },
  },
  {
    keywords: ["steuerberater", "rechtsanwalt", "notar", "beratung"],
    label: "Rechts- und Beratungskosten",
    accounts: { SKR03: "4950", SKR04: "6825" },
  },
  {
    keywords: ["fachbuch", "thalia", "zeitschrift", "abo "],
    label: "Fachliteratur",
    accounts: { SKR03: "4940", SKR04: "6820" },
  },
];

/** First keyword row matching the text (lowercase, already normalised). */
export function keywordAccount(text: string, chart: Chart): { account: string; label: string } | null {
  const t = ` ${text.toLowerCase()} `;
  for (const row of EXPENSE_KEYWORDS) {
    if (row.keywords.some((k) => t.includes(k))) return { account: row.accounts[chart], label: row.label };
  }
  return null;
}
