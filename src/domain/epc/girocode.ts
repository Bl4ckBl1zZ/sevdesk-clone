/**
 * EPC QR code / GiroCode payload (EPC069-12 v002; F04 DOC-51, INV-33, MISC-01, T-DOC-034).
 *
 * Service tag BCD, version 002, character set 1 (UTF-8), SCT, optional BIC, beneficiary = account holder, IBAN,
 * amount "EUR1190.00", no purpose, no structured (RF) reference, unstructured remittance = exactly the payment
 * reference (invoice number + optional prefix). Max 331 bytes; the QR uses error correction level M.
 */
import { electronicFormatIBAN, isValidIBAN } from "ibantools";
import type { DocumentSnapshot } from "../documents/snapshot";
import { formatDecimal } from "../money/format";
import { err, type Issue, issue, ok, type Result } from "../result";

export const EPC_MAX_BYTES = 331;

export interface GirocodeInput {
  readonly name: string;
  readonly iban: string;
  readonly bic?: string;
  readonly amountCents: number;
  readonly remittance: string;
}

export type GirocodeIssueCode = "epc_iban_invalid" | "epc_amount_invalid" | "epc_too_long";

export function girocodePayload(input: GirocodeInput): Result<string, Issue<GirocodeIssueCode>> {
  const iban = electronicFormatIBAN(input.iban) ?? "";
  if (!isValidIBAN(iban)) return err(issue("epc_iban_invalid", `Die IBAN ${input.iban} ist ungültig.`));
  // EPC: 0.01 ≤ amount ≤ 999999999.99
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 1 || input.amountCents > 99_999_999_999) {
    return err(issue("epc_amount_invalid", "Der GiroCode-Betrag muss zwischen 0,01 und 999.999.999,99 € liegen."));
  }
  const amount = `EUR${formatDecimal(input.amountCents, 2).replace(/\./g, "").replace(",", ".")}`;
  const payload = [
    "BCD",
    "002",
    "1",
    "SCT",
    input.bic ?? "",
    input.name.slice(0, 70),
    iban,
    amount,
    "",
    "",
    input.remittance.slice(0, 140),
  ].join("\n");
  if (new TextEncoder().encode(payload).length > EPC_MAX_BYTES) {
    return err(issue("epc_too_long", "Die GiroCode-Daten sind länger als 331 Byte."));
  }
  return ok(payload);
}

/**
 * DOC-51 / App. F: EUR invoice types with a positive payable amount, payment method transfer, a bank account and the
 * QR enabled on the document. Proforma, Storno, corrections and refunds (INV-33) never get a QR.
 */
export function girocodeFor(s: DocumentSnapshot): string | null {
  const types = ["invoice", "advance_invoice", "partial_invoice", "final_invoice", "reminder"];
  const acc = s.payment.bankAccount;
  // Reminders: optional QR with the total claim (F05 DUN-005).
  const amountCents = s.type === "reminder" ? (s.reminder?.totalCents ?? 0) : s.totals.payableCents;
  if (!types.includes(s.type) || s.currency !== "EUR" || amountCents <= 0) return null;
  if (s.payment.method !== "transfer" || !acc || !s.payment.showEpcQr) return null;
  const r = girocodePayload({
    name: acc.accountHolder,
    iban: acc.iban,
    ...(acc.bic ? { bic: acc.bic } : {}),
    amountCents,
    remittance: s.payment.paymentReference,
  });
  return r.ok ? r.value : null;
}
