/**
 * Supplier key (F06 VOU-040): VAT ID → IBAN → normalised name. The key identifies a supplier across vouchers for
 * the account suggestions (`supplierProfiles`, VOU-041/042) and the duplicate checks (VOU-051/052).
 *
 * Name normalisation: lowercase, umlaut folding (ä→ae, ö→oe, ü→ue, ß→ss), accents removed, punctuation removed and
 * legal-form tokens stripped (GmbH, AG, UG (haftungsbeschränkt), e.K., KG, OHG, GbR, mbH, & Co., Inc., Ltd., LLC,
 * S.A., B.V., SE). Pure.
 */

const LEGAL_FORM_PATTERNS: readonly RegExp[] = [
  /\bug\s*\(?\s*haftungsbeschraenkt\s*\)?/g,
  /&\s*co\.?(\s*kg)?/g,
  /\bgmbh\b/g,
  /\bmbh\b/g,
  /\bag\b/g,
  /\bug\b/g,
  /\be\.\s*k\.?(?=\s|$)/g,
  /\bek\b/g,
  /\bkg\b/g,
  /\bohg\b/g,
  /\bgbr\b/g,
  /\binc\b\.?/g,
  /\bltd\b\.?/g,
  /\bllc\b/g,
  /\bs\.\s*a\.?(?=\s|$)/g,
  /\bb\.\s*v\.?(?=\s|$)/g,
  /\bse\b/g,
];

export function normaliseSupplierName(name: string): string {
  let s = name
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  for (const re of LEGAL_FORM_PATTERNS) s = s.replace(re, " ");
  return s
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const compact = (s: string) => s.toUpperCase().replace(/[\s.-]/g, "");

export interface SupplierIdentity {
  vatId?: string | undefined;
  iban?: string | undefined;
  name?: string | undefined;
}

/** `vat:DE123…` | `iban:DE89…` | `name:muster` — or null when nothing identifies the supplier. */
export function supplierKey(s: SupplierIdentity): string | null {
  if (s.vatId?.trim()) return `vat:${compact(s.vatId)}`;
  if (s.iban?.trim()) return `iban:${compact(s.iban)}`;
  const n = s.name ? normaliseSupplierName(s.name) : "";
  return n ? `name:${n}` : null;
}

/** All keys a supplier can be found under (lookup cascade: VAT ID, then IBAN, then name). */
export function supplierKeys(s: SupplierIdentity): string[] {
  const out: string[] = [];
  if (s.vatId?.trim()) out.push(`vat:${compact(s.vatId)}`);
  if (s.iban?.trim()) out.push(`iban:${compact(s.iban)}`);
  const n = s.name ? normaliseSupplierName(s.name) : "";
  if (n) out.push(`name:${n}`);
  return out;
}

/** Jaro-Winkler similarity in [0, 1] (VOU-052 „möglich“ ≥ 0.85). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 1 : 1;
  if (a.length === 0 || b.length === 0) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array<boolean>(a.length).fill(false);
  const bMatch = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(b.length - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}
