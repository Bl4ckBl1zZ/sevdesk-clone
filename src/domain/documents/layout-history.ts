/**
 * F01 SET-076 layout version history: a German diff summary between two versions of a layout config. Versions are
 * immutable (GOBD-06); „Diese Version wiederherstellen“ appends a new version with the old config.
 */
import { PRINT_OPTION_KEYS } from "./layout";

type PrintOptionKey = (typeof PRINT_OPTION_KEYS)[number];

export interface LayoutConfigLike {
  readonly template: string;
  readonly accentColor: string;
  readonly font: string;
  readonly logoPosition: string;
  readonly letterheadStorageId?: string | undefined;
  readonly letterheadPage2StorageId?: string | undefined;
  readonly printOptions: Readonly<Record<PrintOptionKey, boolean>> & {
    readonly footerInLetterhead: { readonly confirmedAt: number; readonly items: readonly string[] } | null;
  };
}

const TEMPLATE_LABEL: Readonly<Record<string, string>> = { classic: "Klassisch", modern: "Modern", minimal: "Minimal" };
const FONT_LABEL: Readonly<Record<string, string>> = {
  inter: "Inter",
  noto: "Noto Sans",
  "source-serif": "Source Serif",
};
const LOGO_LABEL: Readonly<Record<string, string>> = { left: "links", right: "rechts" };

export const PRINT_OPTION_LABEL_DE: Readonly<Record<PrintOptionKey, string>> = {
  foldMarks: "Falzmarken",
  pageNumbers: "Seitenzahlen",
  senderLine: "Absenderzeile",
  vatPerLine: "USt je Position",
  productNumbers: "Artikelnummern",
  lineDescriptions: "Positionsbeschreibungen",
  grossLineTotals: "Bruttobeträge je Position",
  epcQr: "EPC-QR-Code",
  portalQr: "Portal-QR-Code",
  allInvoiceAccountsInFooter: "Alle Rechnungskonten in der Fußzeile",
};

const label = (map: Readonly<Record<string, string>>, v: string) => map[v] ?? v;

/** Changes from `prev` to `next`; `prev` null = first version („Erste Version“). */
export function layoutDiffSummary(prev: LayoutConfigLike | null, next: LayoutConfigLike): string[] {
  if (!prev) return ["Erste Version"];
  const out: string[] = [];
  if (prev.template !== next.template) {
    out.push(`Vorlage: ${label(TEMPLATE_LABEL, prev.template)} → ${label(TEMPLATE_LABEL, next.template)}`);
  }
  if (prev.accentColor.toLowerCase() !== next.accentColor.toLowerCase()) {
    out.push(`Akzentfarbe: ${prev.accentColor} → ${next.accentColor}`);
  }
  if (prev.font !== next.font) out.push(`Schrift: ${label(FONT_LABEL, prev.font)} → ${label(FONT_LABEL, next.font)}`);
  if (prev.logoPosition !== next.logoPosition) {
    out.push(`Logo: ${label(LOGO_LABEL, prev.logoPosition)} → ${label(LOGO_LABEL, next.logoPosition)}`);
  }
  if (prev.letterheadStorageId !== next.letterheadStorageId) {
    out.push(next.letterheadStorageId ? "Briefpapier geändert" : "Briefpapier entfernt");
  }
  if (prev.letterheadPage2StorageId !== next.letterheadPage2StorageId) out.push("Briefpapier Folgeseiten geändert");
  for (const k of PRINT_OPTION_KEYS) {
    if (prev.printOptions[k] !== next.printOptions[k]) {
      out.push(`${PRINT_OPTION_LABEL_DE[k]} ${next.printOptions[k] ? "an" : "aus"}`);
    }
  }
  const pf = prev.printOptions.footerInLetterhead;
  const nf = next.printOptions.footerInLetterhead;
  if ((pf === null) !== (nf === null) || (pf && nf && pf.items.join() !== nf.items.join())) {
    out.push(nf ? "Fußzeile im Briefpapier bestätigt" : "Fußzeile wieder gedruckt");
  }
  return out.length ? out : ["Keine Änderung"];
}

/** True when two configs render identically (restore of the current version is a no-op). */
export const sameLayoutConfig = (a: LayoutConfigLike, b: LayoutConfigLike): boolean =>
  layoutDiffSummary(a, b)[0] === "Keine Änderung";
