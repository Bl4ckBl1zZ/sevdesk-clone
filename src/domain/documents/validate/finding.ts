/**
 * Validator output (F04 §5: `{ code, severity, field, rule, message, params }`). E = blocking at finalisation,
 * W = warning, I = info. The compliance panel (DOC-20) groups findings as in §4.4 item 6.
 */
export type Severity = "E" | "W" | "I";

export type FindingGroup = "pflichtangaben" | "steuern" | "e_rechnung" | "hinweise";

export interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  /** Compliance IDs (01) or rule IDs, e.g. "UST-03". */
  readonly rule: string;
  readonly group: FindingGroup;
  /** Editor field (or settings path "settings/…") that fixes it. */
  readonly field?: string;
  readonly params?: Readonly<Record<string, string | number>>;
  /** E findings that may be released with an audited reason (`buyer_vat_id_not_verified`, EC-044). */
  readonly overridable?: boolean;
}

export const isBlocking = (f: Finding): boolean => f.severity === "E";

export const blocking = (findings: readonly Finding[]): Finding[] => findings.filter(isBlocking);

export function finding(
  code: string,
  severity: Severity,
  rule: string,
  group: FindingGroup,
  message: string,
  extra: { field?: string; params?: Readonly<Record<string, string | number>>; overridable?: boolean } = {},
): Finding {
  return {
    code,
    severity,
    rule,
    group,
    message,
    ...(extra.field !== undefined ? { field: extra.field } : {}),
    ...(extra.params !== undefined ? { params: extra.params } : {}),
    ...(extra.overridable ? { overridable: true } : {}),
  };
}
