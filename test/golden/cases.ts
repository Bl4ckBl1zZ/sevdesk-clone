/**
 * Golden case loader (07 §4, F04 §8.2). Each `cases/<case>/input.json` names the F04 test-case ID, the seller/buyer
 * presets from `test/factories/snapshot.ts` and the overrides of the T-GLD-01 base input; the golden runner and the
 * e-invoice validation integration test both build the snapshots from here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshot, type SnapshotInput } from "@/domain/documents/build-snapshot";
import { DEFAULT_LAYOUT, type RenderLayout, type RenderVariant } from "@/domain/documents/render-model";
import { companyAsBuyer } from "@/domain/documents/self-billing";
import {
  type DocumentSnapshot,
  isInvoiceType,
  type SnapshotBuyer,
  type SnapshotIssuer,
  type SnapshotSeller,
} from "@/domain/documents/snapshot";
import type { XmlFormat } from "@/domain/einvoice/serialize";
import { BUYERS, type BuyerPreset, makeSnapshotInput, SELLERS, type SellerPreset } from "../factories/snapshot";

export const CASES_DIR = join(import.meta.dirname, "cases");

export interface GoldenCaseFile {
  /** F04 test-case ID (T-GLD-xx) or another spec ID the case covers. */
  readonly id: string;
  readonly title: string;
  readonly seller?: SellerPreset;
  readonly sellerPatch?: Partial<SnapshotSeller>;
  readonly buyer?: BuyerPreset;
  readonly buyerPatch?: Partial<SnapshotBuyer>;
  readonly input?: Partial<SnapshotInput>;
  /** Merged into the base payment (transfer, 30 days, bank account, EPC-QR). */
  readonly paymentPatch?: Partial<SnapshotInput["payment"]>;
  readonly variant?: RenderVariant;
  readonly layout?: Partial<Omit<RenderLayout, "printOptions">> & {
    readonly printOptions?: Partial<RenderLayout["printOptions"]>;
  };
  /**
   * Self-billing Gutschrift (F04 §4.9): our company preset as the letter issuer and the BG-7 buyer; `seller` is then
   * the supplier. Like the pipeline, the document carries no bank account of ours and no EPC QR.
   */
  readonly issuer?: SellerPreset;
  /** The snapshot must be rejected with this issue code (no outputs). */
  readonly expectError?: string;
}

export interface GoldenCase {
  readonly dir: string;
  readonly file: GoldenCaseFile;
  readonly input: SnapshotInput;
  readonly layout: RenderLayout;
  readonly variant: RenderVariant;
}

const withoutTaxFlags = ({ kleinunternehmer: _ku, vatAccounting: _va, ...rest }: SnapshotSeller): SnapshotIssuer =>
  rest;

export function loadGoldenCases(): GoldenCase[] {
  return readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((dir) => {
      const file = JSON.parse(readFileSync(join(CASES_DIR, dir, "input.json"), "utf8")) as GoldenCaseFile;
      const seller = { ...SELLERS[file.seller ?? "gmbh"], ...file.sellerPatch } as SnapshotSeller;
      const issuer = file.issuer ? withoutTaxFlags(SELLERS[file.issuer]) : undefined;
      const buyer = {
        ...(issuer ? companyAsBuyer(issuer) : BUYERS[file.buyer ?? "b2b"]),
        ...file.buyerPatch,
      } as SnapshotBuyer;
      const base = makeSnapshotInput({ seller, buyer, ...(issuer ? { issuer } : {}), ...file.input });
      const { bankAccount: _ours, ...noBank } = base.payment;
      const payment = issuer ? { ...noBank, showEpcQr: false } : base.payment;
      // `null` in input.json removes a base field (e.g. the supply date of a quote).
      const merged: Record<string, unknown> = { ...base, payment: { ...payment, ...file.paymentPatch } };
      for (const [key, value] of Object.entries(file.input ?? {})) if (value === null) delete merged[key];
      const input = merged as unknown as SnapshotInput;
      const layout: RenderLayout = {
        ...DEFAULT_LAYOUT,
        ...file.layout,
        printOptions: { ...DEFAULT_LAYOUT.printOptions, ...file.layout?.printOptions },
      };
      return { dir, file, input, layout, variant: file.variant ?? "original" };
    });
}

export function goldenSnapshot(c: GoldenCase): DocumentSnapshot {
  const r = buildSnapshot(c.input);
  if (!r.ok) throw new Error(`${c.dir}: ${r.error.code} ${r.error.message}`);
  return r.value;
}

/** The CII golden: ZUGFeRD/Factur-X EN 16931 unless the document uses an XRechnung CII profile. */
export function ciiFormat(s: DocumentSnapshot): XmlFormat | null {
  if (!isInvoiceType(s.type)) return null;
  if (s.einvoice.format === "zugferd_xrechnung" || s.einvoice.format === "xrechnung_cii") return s.einvoice.format;
  return "zugferd_en16931";
}

/** The UBL golden: XRechnung UBL for every invoice type. */
export const ublFormat = (s: DocumentSnapshot): XmlFormat | null => (isInvoiceType(s.type) ? "xrechnung_ubl" : null);
