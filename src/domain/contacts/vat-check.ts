/**
 * USt-IdNr online checks (F02 §3.5, §4.2, MISC-04): provider choice (eVatR qualified for foreign IDs, VIES simple for
 * DE IDs and as fallback), request bodies, response mapping to the stored evidence (`vatIdChecks`, 03 §2), the
 * contact status (CON-054/055), the 24-hour reuse rule (CON-058), retention (CON-053) and the finalisation gate data
 * for K/AE (CON-056/057, RI-16). Pure: the HTTP call is done by the Convex action with these shapes.
 */
import { evatrStatus } from "../rules/evatr-status";
import type { TaxCase } from "../tax/tax-case";
import { addDays, type CalendarDate, formatGermanDate } from "../time/calendar-date";
import type { PostalAddress } from "./address";

export type VatCheckProvider = "bzst_evatr" | "eu_vies";
export type VatCheckStatus = "valid" | "invalid" | "unavailable";
export type QualifiedCode = "A" | "B" | "C" | "D";

export const PROVIDER_LABELS: Readonly<Record<VatCheckProvider, string>> = {
  bzst_evatr: "BZSt (eVatR)",
  eu_vies: "EU-Kommission (VIES)",
};

export const QUALIFIED_CODE_LABELS: Readonly<Record<QualifiedCode, string>> = {
  A: "stimmt überein",
  B: "stimmt nicht überein",
  C: "nicht angefragt",
  D: "vom Mitgliedstaat nicht mitgeteilt",
};

export interface QualifiedResult {
  readonly name: QualifiedCode;
  readonly street: QualifiedCode;
  readonly postalCode: QualifiedCode;
  readonly city: QualifiedCode;
}

/** The evidence row as stored (03 §2 `vatIdChecks`, without ids). */
export interface VatCheckEvidence {
  readonly vatId: string;
  readonly provider: VatCheckProvider;
  readonly request: unknown;
  readonly response: unknown;
  readonly status: VatCheckStatus;
  readonly qualified?: QualifiedResult;
  readonly providerRequestId?: string;
  readonly checkedAt: number;
  readonly retentionUntil: string;
  /** German result text shown in the history (status message of the provider or our classification). */
  readonly message: string;
}

// ── provider choice (§4.2 step 3) ──────────────────────────────────────────────────────────────────────
export interface CheckPlan {
  readonly provider: VatCheckProvider;
  /** eVatR without own USt-IdNr → VIES with this warning (§5.4). */
  readonly warning?: string;
}

export const NO_OWN_VAT_ID_WARNING =
  "Eine qualifizierte Bestätigung beim BZSt ist nur mit eigener USt-IdNr möglich; es wurde einfach über VIES geprüft.";

export function planCheck(vatId: string, ownVatId: string | undefined): CheckPlan {
  if (vatId.startsWith("DE")) return { provider: "eu_vies" };
  if (!ownVatId) return { provider: "eu_vies", warning: NO_OWN_VAT_ID_WARNING };
  return { provider: "bzst_evatr" };
}

// ── request bodies (CON-051/052, T-CON-034/035) ────────────────────────────────────────────────────────
export interface EvatrRequest {
  readonly anfragendeUstid: string;
  readonly angefragteUstid: string;
  readonly firmenname?: string;
  readonly ort?: string;
  readonly plz?: string;
  readonly strasse?: string;
}

/** CON-051: our DE ID, the foreign ID and name/city/postcode/street from the default billing address. */
export function evatrRequest(ownVatId: string, vatId: string, name: string, address?: PostalAddress): EvatrRequest {
  const opt = (k: keyof EvatrRequest, v: string | undefined) => (v?.trim() ? { [k]: v.trim() } : {});
  return {
    anfragendeUstid: ownVatId,
    angefragteUstid: vatId,
    ...opt("firmenname", name),
    ...opt("ort", address?.city),
    ...opt("plz", address?.postalCode),
    ...opt("strasse", address?.street),
  };
}

export interface ViesRequest {
  readonly countryCode: string;
  readonly vatNumber: string;
  readonly requesterMemberStateCode?: string;
  readonly requesterNumber?: string;
  readonly traderName?: string;
  readonly traderStreet?: string;
  readonly traderPostalCode?: string;
  readonly traderCity?: string;
}

/** CON-052: VIES with requester fields (needed to obtain `requestIdentifier`). */
export function viesRequest(vatId: string, ownVatId?: string, name?: string, address?: PostalAddress): ViesRequest {
  const opt = (k: keyof ViesRequest, v: string | undefined) => (v?.trim() ? { [k]: v.trim() } : {});
  return {
    countryCode: vatId.slice(0, 2),
    vatNumber: vatId.slice(2),
    ...(ownVatId ? { requesterMemberStateCode: ownVatId.slice(0, 2), requesterNumber: ownVatId.slice(2) } : {}),
    ...opt("traderName", name),
    ...opt("traderStreet", address?.street),
    ...opt("traderPostalCode", address?.postalCode),
    ...opt("traderCity", address?.city),
  };
}

// ── response mapping (§4.2 table) ──────────────────────────────────────────────────────────────────────
export interface ProviderOutcome {
  readonly status: VatCheckStatus;
  readonly qualified?: QualifiedResult;
  readonly providerRequestId?: string;
  readonly message: string;
}

const code = (v: unknown): QualifiedCode => (v === "A" || v === "B" || v === "C" || v === "D" ? v : "C");

/** eVatR response (HTTP status + body) → outcome. Unknown or malformed answers → unavailable. */
export function mapEvatrResponse(httpStatus: number, body: unknown): ProviderOutcome {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const statusCode = typeof b.status === "string" ? b.status : undefined;
  if (!statusCode) {
    return {
      status: "unavailable",
      message: `Der Prüfdienst (${PROVIDER_LABELS.bzst_evatr}) hat keine verwertbare Antwort geliefert (HTTP ${httpStatus}).`,
    };
  }
  const entry = evatrStatus(statusCode);
  const id = typeof b.id === "string" && b.id ? { providerRequestId: b.id } : {};
  const status: VatCheckStatus =
    entry.outcome === "valid" ? "valid" : entry.outcome === "invalid" ? "invalid" : "unavailable";
  const hasQualified = ["ergFirmenname", "ergOrt", "ergPlz", "ergStrasse"].some((k) => typeof b[k] === "string");
  const qualified = hasQualified
    ? {
        qualified: {
          name: code(b.ergFirmenname),
          street: code(b.ergStrasse),
          postalCode: code(b.ergPlz),
          city: code(b.ergOrt),
        },
      }
    : {};
  return { status, ...qualified, ...id, message: `${statusCode}: ${entry.message}` };
}

const viesCode = (v: unknown): QualifiedCode =>
  v === "VALID" ? "A" : v === "INVALID" ? "B" : v === "NOT_PROCESSED" ? "C" : "C";

/**
 * VIES response → outcome. Errors (`errorWrappers`) are unavailable except `INVALID_INPUT` (invalid).
 * UNSURE (research 06 §B3): the VIES error codes are inferred from the SOAP fault codes.
 */
export function mapViesResponse(httpStatus: number, body: unknown): ProviderOutcome {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const wrappers = Array.isArray(b.errorWrappers) ? (b.errorWrappers as { error?: unknown; message?: unknown }[]) : [];
  if (httpStatus !== 200 || wrappers.length > 0 || typeof b.valid !== "boolean") {
    const err = String(wrappers[0]?.error ?? b.userError ?? `HTTP ${httpStatus}`);
    if (err === "INVALID_INPUT")
      return { status: "invalid", message: "VIES: INVALID_INPUT – die USt-IdNr ist ungültig." };
    return {
      status: "unavailable",
      message: `Der Prüfdienst (${PROVIDER_LABELS.eu_vies}) ist derzeit nicht erreichbar (${err}). Bitte später erneut prüfen.`,
    };
  }
  const id =
    typeof b.requestIdentifier === "string" && b.requestIdentifier ? { providerRequestId: b.requestIdentifier } : {};
  const matches = ["traderNameMatch", "traderStreetMatch", "traderPostalCodeMatch", "traderCityMatch"];
  const qualified = matches.some((k) => typeof b[k] === "string")
    ? {
        qualified: {
          name: viesCode(b.traderNameMatch),
          street: viesCode(b.traderStreetMatch),
          postalCode: viesCode(b.traderPostalCodeMatch),
          city: viesCode(b.traderCityMatch),
        },
      }
    : {};
  return {
    status: b.valid ? "valid" : "invalid",
    ...qualified,
    ...id,
    message: b.valid ? "VIES: Die USt-IdNr ist gültig." : "VIES: Die USt-IdNr ist ungültig.",
  };
}

// ── evidence and status ───────────────────────────────────────────────────────────────────────────────
/** CON-053: end of the check year + 10 years (e.g. checked 2026-10-12 → 2036-12-31). */
export function vatCheckRetentionUntil(checkedOn: CalendarDate): string {
  return `${Number(checkedOn.slice(0, 4)) + 10}-12-31`;
}

/**
 * CON-054: `qualified = true` only if eVatR returned valid and A for name and city (street/postal code A or C).
 */
export function isQualified(provider: VatCheckProvider, status: VatCheckStatus, q?: QualifiedResult): boolean {
  if (provider !== "bzst_evatr" || status !== "valid" || !q) return false;
  const ok = (c: QualifiedCode) => c === "A" || c === "C";
  return q.name === "A" && q.city === "A" && ok(q.street) && ok(q.postalCode);
}

export interface VatIdStatus {
  readonly lastCheckId: string;
  readonly status: VatCheckStatus;
  readonly qualified: boolean;
  readonly checkedAt: number;
}

export type VatBadgeKind = "qualified" | "valid" | "mismatch" | "invalid" | "unchecked" | "unavailable";

/** CON-055 badge texts. `mismatch` = valid, but the qualified name/city check returned B (or D). */
export function vatBadge(
  status: { status: VatCheckStatus; qualified: boolean; checkedAt: number } | undefined,
  qualifiedCodes: QualifiedResult | undefined,
  formatDate: (ms: number) => string,
): { kind: VatBadgeKind; text: string } {
  if (!status) return { kind: "unchecked", text: "? nicht geprüft" };
  const date = formatDate(status.checkedAt);
  if (status.status === "unavailable") return { kind: "unavailable", text: "⏳ Dienst nicht erreichbar" };
  if (status.status === "invalid") return { kind: "invalid", text: `✗ ungültig (${date})` };
  if (status.qualified) return { kind: "qualified", text: `✓ qualifiziert bestätigt am ${date}` };
  if (qualifiedCodes && (qualifiedCodes.name === "B" || qualifiedCodes.city === "B")) {
    return { kind: "mismatch", text: "⚠ gültig, Name/Ort weicht ab" };
  }
  if (qualifiedCodes && (qualifiedCodes.name === "D" || qualifiedCodes.city === "D")) {
    return { kind: "mismatch", text: "⚠ gültig, Mitgliedstaat liefert keine Daten" };
  }
  return { kind: "valid", text: `✓ gültig (einfache Prüfung) am ${date}` };
}

// ── 24-hour reuse (CON-058) ───────────────────────────────────────────────────────────────────────────
export interface CheckFingerprint {
  readonly vatId: string;
  readonly name: string;
  readonly street?: string | undefined;
  readonly postalCode?: string | undefined;
  readonly city?: string | undefined;
}

export const fingerprint = (f: CheckFingerprint): string =>
  [f.vatId, f.name, f.street ?? "", f.postalCode ?? "", f.city ?? ""].map((s) => s.trim().toLowerCase()).join("|");

const DAY_MS = 86_400_000;

/** Returns the stored check to reuse (same ID + same name/address within 24 h, not forced), else null. */
export function reusableCheck<
  T extends { checkedAt: number; fingerprint?: string | undefined; status: VatCheckStatus },
>(checks: readonly T[], fp: string, now: number, force: boolean): T | null {
  if (force) return null;
  const recent = checks
    .filter((c) => c.fingerprint === fp && now - c.checkedAt < DAY_MS && c.status !== "unavailable")
    .sort((a, b) => b.checkedAt - a.checkedAt);
  return recent[0] ?? null;
}

// ── finalisation gate for K/AE (CON-056/057, §4.3) ─────────────────────────────────────────────────────
export type VatGateDecision =
  | { readonly kind: "ok"; readonly checkId: string }
  | { readonly kind: "recheck" }
  | {
      readonly kind: "blocked";
      readonly code: string;
      readonly message: string;
      /** Override with a reason is allowed (audit `vat_check.override`, EC-044). */
      readonly overridable: boolean;
      readonly warning?: string;
    }
  | { readonly kind: "ok_with_warning"; readonly checkId: string; readonly warning: string };

export interface GateCheck {
  readonly id: string;
  readonly vatId: string;
  readonly provider: VatCheckProvider;
  readonly status: VatCheckStatus;
  readonly qualified?: QualifiedResult | undefined;
  readonly checkedOn: CalendarDate;
}

export const VAT_CHECK_MAX_AGE_DAYS = 90;

/**
 * §4.3 decision for `eu_b2b_service` (AE) and `intra_community_supply` (K). `checks` are the contact's checks of the
 * current VAT ID, newest first. Other tax cases → ok without check. "recheck" tells the caller to run an inline check
 * (timeout 10 s, CON-057) and call again with the new result.
 */
export function vatCheckGate(input: {
  taxCase: TaxCase;
  vatId: string | undefined;
  isEuPrefixOnSupplyDate: boolean;
  checks: readonly GateCheck[];
  today: CalendarDate;
  recheckDone?: boolean;
}): VatGateDecision {
  const { taxCase, vatId } = input;
  if (taxCase !== "eu_b2b_service" && taxCase !== "intra_community_supply") return { kind: "ok", checkId: "" };
  if (!vatId) {
    return { kind: "blocked", code: "VAT_ID_MISSING", message: "USt-IdNr des Kunden fehlt", overridable: false };
  }
  if (vatId.startsWith("DE") || !input.isEuPrefixOnSupplyDate) {
    return {
      kind: "blocked",
      code: "VAT_ID_NOT_FOREIGN_EU",
      message: "Keine ausländische EU-USt-IdNr",
      overridable: false,
    };
  }
  const own = input.checks.filter((c) => c.vatId === vatId);
  const latest = own[0];
  const fresh = (c: GateCheck) => addDays(c.checkedOn, VAT_CHECK_MAX_AGE_DAYS) >= input.today;
  if (!latest || (latest.status === "valid" && !fresh(latest))) {
    if (!input.recheckDone) return { kind: "recheck" };
  }
  if (!latest || latest.status === "unavailable" || (latest.status === "valid" && !fresh(latest))) {
    return {
      kind: "blocked",
      code: "VAT_CHECK_UNAVAILABLE",
      message: `Der Prüfdienst ist derzeit nicht erreichbar. Bitte später erneut prüfen oder mit Begründung fortfahren.`,
      overridable: true,
    };
  }
  if (latest.status === "invalid") {
    return {
      kind: "blocked",
      code: "VAT_ID_INVALID",
      message: `Die USt-IdNr ${vatId} ist laut ${PROVIDER_LABELS[latest.provider]} am ${formatGermanDate(latest.checkedOn)} ungültig.`,
      overridable: false,
    };
  }
  if (taxCase === "intra_community_supply") {
    const qualifiedName = latest.provider === "bzst_evatr" && latest.qualified?.name === "A";
    if (!qualifiedName) {
      return {
        kind: "blocked",
        code: "VAT_CHECK_NOT_QUALIFIED",
        message:
          "Für eine innergemeinschaftliche Lieferung ist eine qualifizierte Bestätigung (Name „A“) erforderlich. Mit Begründung fortfahren?",
        overridable: true,
      };
    }
  } else if (latest.qualified && (latest.qualified.name === "B" || latest.qualified.city === "B")) {
    return {
      kind: "ok_with_warning",
      checkId: latest.id,
      warning: "Die USt-IdNr ist gültig, Name oder Ort weichen bei der qualifizierten Prüfung ab.",
    };
  }
  return { kind: "ok", checkId: latest.id };
}

/** REASON_REQUIRED for overrides (§5.4). */
export const OVERRIDE_REASON_REQUIRED =
  "Bitte begründen, warum ohne gültige Prüfung fortgefahren wird (wird protokolliert).";

/** CON-059: contacts with K/AE invoices in the last 12 months whose last valid check is older than 90 days. */
export function needsNightlyRecheck(lastValidCheckOn: CalendarDate | undefined, today: CalendarDate): boolean {
  return lastValidCheckOn === undefined || addDays(lastValidCheckOn, VAT_CHECK_MAX_AGE_DAYS) < today;
}
