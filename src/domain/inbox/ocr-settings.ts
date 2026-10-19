/**
 * Claude OCR settings (F01 SET-111…113, F06 INB-025, EC-INB-16/17, DSGVO-04, AO-06). Pure checks; the API key is
 * stored encrypted by the model layer and never passes through here.
 *
 * Defaults (conservative): disabled until the owner enables it with the AVV confirmation; model
 * `claude-sonnet-5-5`; first 5 pages; the region defaults to `"global"` — the Anthropic API processes data outside
 * the EU — so the NON_EU warning is shown until the owner declares an EU-hosted endpoint (`region: "eu"`).
 */

export type ClaudeRegion = "eu" | "us" | "global" | "other";

export interface ClaudeSettings {
  /** Custom base URL (e.g. an EU-hosted endpoint); absent = Anthropic API. */
  endpoint?: string;
  model: string;
  /** Declared processing region of the endpoint (F01 SET-111). */
  region: ClaudeRegion;
  /** OCR only on the first N pages (INB-025). */
  pageLimit: number;
  /** Optional monthly request cap; over budget → manual entry (INB-025). */
  monthlyBudget?: number;
}

export const CLAUDE_DEFAULTS: ClaudeSettings = { model: "claude-sonnet-5-5", region: "global", pageLimit: 5 };

export const CLAUDE_SETTINGS_MESSAGES = {
  dpaRequired:
    "Bitte bestätigen: „Ich habe einen Auftragsverarbeitungsvertrag (AVV) mit dem Anbieter abgeschlossen“ – ohne AVV kann die Belegerkennung nicht aktiviert werden.",
  nonEu: (region: string) =>
    `Achtung: Der Dienst verarbeitet Daten außerhalb der EU (${region}). Prüfen Sie Standardvertragsklauseln bzw. das EU-US Data Privacy Framework (Art. 44 ff. DSGVO).`,
  /** EC-INB-17 (shown together with `nonEu` on save). */
  nonEuOcr:
    "Der OCR-Dienst verarbeitet Daten außerhalb der EU. Auftragsverarbeitungsvertrag und § 146 Abs. 2b AO beachten.",
  endpointInvalid: "Bitte eine gültige HTTPS-Adresse für den Endpunkt angeben.",
  modelRequired: "Bitte ein Modell angeben.",
  pageLimitInvalid: "Die Seitenbegrenzung muss zwischen 1 und 100 liegen.",
  budgetInvalid: "Das Monatsbudget muss eine positive ganze Zahl sein.",
} as const;

const REGION_LABEL: Record<ClaudeRegion, string> = {
  eu: "EU",
  us: "USA",
  global: "weltweit",
  other: "außerhalb der EU",
};

export interface ClaudeSettingsCheck {
  errors: { code: string; message: string }[];
  warnings: { code: "NON_EU_ENDPOINT"; message: string }[];
}

export function checkClaudeSettings(input: {
  enabled: boolean;
  dpaConfirmed: boolean;
  region: ClaudeRegion;
  endpoint?: string;
  model?: string;
  pageLimit?: number;
  monthlyBudget?: number;
}): ClaudeSettingsCheck {
  const errors: ClaudeSettingsCheck["errors"] = [];
  const warnings: ClaudeSettingsCheck["warnings"] = [];
  if (input.enabled && !input.dpaConfirmed)
    errors.push({ code: "dpa_required", message: CLAUDE_SETTINGS_MESSAGES.dpaRequired });
  if (input.endpoint !== undefined && input.endpoint.trim() !== "") {
    let ok = false;
    try {
      ok = new URL(input.endpoint.trim()).protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) errors.push({ code: "endpoint_invalid", message: CLAUDE_SETTINGS_MESSAGES.endpointInvalid });
  }
  if (input.model !== undefined && input.model.trim() === "") {
    errors.push({ code: "model_required", message: CLAUDE_SETTINGS_MESSAGES.modelRequired });
  }
  if (
    input.pageLimit !== undefined &&
    (!Number.isInteger(input.pageLimit) || input.pageLimit < 1 || input.pageLimit > 100)
  ) {
    errors.push({ code: "page_limit_invalid", message: CLAUDE_SETTINGS_MESSAGES.pageLimitInvalid });
  }
  if (input.monthlyBudget !== undefined && (!Number.isInteger(input.monthlyBudget) || input.monthlyBudget < 1)) {
    errors.push({ code: "budget_invalid", message: CLAUDE_SETTINGS_MESSAGES.budgetInvalid });
  }
  if (input.region !== "eu") {
    warnings.push({
      code: "NON_EU_ENDPOINT",
      message: `${CLAUDE_SETTINGS_MESSAGES.nonEu(REGION_LABEL[input.region])} ${CLAUDE_SETTINGS_MESSAGES.nonEuOcr}`,
    });
  }
  return { errors, warnings };
}

/** INB-025: monthly call budget reached? (`usage.month` = "YYYY-MM"; a new month starts at 0.) */
export function budgetExceeded(
  usage: { month: string; calls: number } | undefined,
  budget: number | undefined,
  today: string,
): boolean {
  if (budget === undefined) return false;
  const calls = usage && usage.month === today.slice(0, 7) ? usage.calls : 0;
  return calls >= budget;
}

/** The usage counter after one more call. */
export function nextUsage(usage: { month: string; calls: number } | undefined, today: string) {
  const month = today.slice(0, 7);
  return { month, calls: usage && usage.month === month ? usage.calls + 1 : 1 };
}
