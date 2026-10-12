/**
 * Buyer reference BT-10 (F02 CON-084, ER-10/ER-20): a valid Leitweg-ID for public authorities (mandatory, also for
 * direct orders ≤ 1.000 €, README A27); otherwise optional free text ≤ 100 characters.
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import { type LeitwegIdIssueCode, validateLeitwegId } from "./leitweg-id";

export const BUYER_REFERENCE_MAX_LENGTH = 100;

export function validateBuyerReference(input: {
  readonly value: string | undefined | null;
  readonly isPublicAuthority: boolean;
}): Result<string | null, Issue<LeitwegIdIssueCode | "too_long">> {
  if (input.isPublicAuthority) return validateLeitwegId(input.value);
  const value = (input.value ?? "").trim();
  if (value === "") return ok(null);
  if (value.length > BUYER_REFERENCE_MAX_LENGTH) {
    return err(issue("too_long", "Die Käuferreferenz ist zu lang (max. 100 Zeichen)."));
  }
  return ok(value);
}

/** Literal last step of the B2B fallback chain (F04 App. A.3, 10 EC-093). */
export const BUYER_REFERENCE_PLACEHOLDER = "nicht angegeben";

export interface BuyerReferenceSources {
  /** Document `buyerReference` (editor field). */
  readonly document?: string | undefined;
  /** Contact `buyerReference` (Leitweg-ID for public authorities). */
  readonly contact?: string | undefined;
  /** BT-13 */ readonly orderReference?: string | undefined;
  /** BT-46 */ readonly contactNumber?: string | undefined;
}

export interface ResolvedBuyerReference {
  readonly value: string | undefined;
  /** Which source supplied the value; `contact_number`/`placeholder` raise the info `buyer_reference_placeholder`. */
  readonly source: "document" | "contact" | "order_reference" | "contact_number" | "placeholder" | "none";
}

const firstFilled = (...values: (string | undefined)[]) => values.map((v) => (v ?? "").trim()).find((v) => v !== "");

/**
 * BT-10 per F04 App. A.3 (ER-10, ER-20, BR-DE-15):
 * - B2G: the Leitweg-ID (document, else contact reference) — validated separately (`leitweg_id_*`).
 * - XRechnung formats (`xrechnung_*`, `zugferd_xrechnung`): document → contact → order reference → contact number →
 *   "nicht angegeben".
 * - ZUGFeRD EN 16931 and documents without XML: only a real reference (document or contact).
 */
export function resolveBuyerReference(input: {
  readonly format: "zugferd_en16931" | "zugferd_xrechnung" | "xrechnung_cii" | "xrechnung_ubl" | "none";
  readonly isPublicAuthority: boolean;
  readonly sources: BuyerReferenceSources;
}): ResolvedBuyerReference {
  const s = input.sources;
  const real = firstFilled(s.document, s.contact);
  const realSource = firstFilled(s.document) ? "document" : "contact";
  if (real) return { value: real, source: realSource };
  if (input.isPublicAuthority || input.format === "zugferd_en16931" || input.format === "none") {
    return { value: undefined, source: "none" };
  }
  const order = firstFilled(s.orderReference);
  if (order) return { value: order, source: "order_reference" };
  const number = firstFilled(s.contactNumber);
  if (number) return { value: number, source: "contact_number" };
  return { value: BUYER_REFERENCE_PLACEHOLDER, source: "placeholder" };
}
