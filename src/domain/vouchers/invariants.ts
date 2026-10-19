/**
 * RI-21 (10-edge-cases §2, GOBD-07/08): every booked voucher has at least one original file — or is a documented
 * (approved) Eigenbeleg, a recurring voucher with a linked reference document, or a voucher whose bank line is the
 * Beleg — and every recorded original carries a SHA-256. Re-hashing the stored bytes needs file access and runs in the
 * nightly integrity job (VOU-126). Pure.
 */
import { hasBeleg } from "./capture";

export interface VoucherInvariantRow {
  id: string;
  label: string;
  status: string;
  kind: string;
  files: readonly { sha256: string; replacedBy?: number }[];
  eigenbelegApproved: boolean;
  recurringReference: boolean;
}

export interface VoucherInvariantViolation {
  id: "RI-21";
  severity: "ERROR";
  message: string;
}

const SHA256 = /^[0-9a-f]{64}$/;

export function checkVoucherBelege(rows: readonly VoucherInvariantRow[]): VoucherInvariantViolation[] {
  const out: VoucherInvariantViolation[] = [];
  for (const r of rows) {
    if (r.status !== "draft" && r.status !== "cancelled") {
      const ok = hasBeleg({
        files: r.files,
        kind: r.kind,
        ...(r.eigenbelegApproved ? { eigenbelegApproved: true } : {}),
        ...(r.recurringReference ? { recurringReference: true } : {}),
      });
      if (!ok)
        out.push({
          id: "RI-21",
          severity: "ERROR",
          message: `Beleg ${r.label} ist gebucht, hat aber keine Belegdatei.`,
        });
    }
    for (const [i, f] of r.files.entries()) {
      if (!SHA256.test(f.sha256)) {
        out.push({
          id: "RI-21",
          severity: "ERROR",
          message: `Beleg ${r.label}: Datei ${i + 1} hat keinen gültigen SHA-256.`,
        });
      }
    }
  }
  return out;
}
