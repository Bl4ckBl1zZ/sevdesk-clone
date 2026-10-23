/**
 * „Mit Banking-App bezahlen“ (F06 VOU-135, MISC-01): a GiroCode (EPC QR) for an open purchase voucher, built with the
 * F04 EPC builder — open amount, supplier (or E-Rechnung payee) IBAN and the supplier's document number as the
 * reference. The app initiates no payment (bank data is read-only); the owner scans the code with a banking app.
 * Only EUR expense vouchers with a positive open amount and a valid IBAN get a code. Pure.
 */
import { girocodePayload } from "../epc/girocode";
import type { VoucherDirection, VoucherStatus } from "./types";

export interface GirocodeVoucher {
  direction: VoucherDirection;
  status: VoucherStatus;
  currency: string;
  openAmountCents: number;
  supplierName?: string;
  supplierIban?: string;
  documentNumber?: string;
  internalNumber?: string;
  payee?: { name: string; iban: string; bic?: string };
}

const PAYABLE: readonly VoucherStatus[] = ["open", "scheduled", "partially_paid"];

export function voucherGirocode(v: GirocodeVoucher): string | null {
  if (v.direction !== "expense" || v.currency !== "EUR" || !PAYABLE.includes(v.status) || v.openAmountCents <= 0) {
    return null;
  }
  const iban = v.payee?.iban ?? v.supplierIban;
  const name = v.payee?.name ?? v.supplierName;
  const remittance = v.documentNumber ?? v.internalNumber;
  if (!iban || !name || !remittance) return null;
  const r = girocodePayload({
    name,
    iban,
    ...(v.payee?.bic ? { bic: v.payee.bic } : {}),
    amountCents: v.openAmountCents,
    remittance,
  });
  return r.ok ? r.value : null;
}
