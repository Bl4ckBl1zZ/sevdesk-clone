import type { NumberRangesFormValues } from "./schema";

/**
 * Seeded number ranges (F01 §5.5) for display before the server has seeded them (SET-006, SET-053).
 * TODO(convex): the server seeds these on setup; the wizard then edits the stored rows from getSetupState().
 * Gutschriften (self_billing, P3) are omitted.
 */
export const SEEDED_RANGES: NumberRangesFormValues["ranges"] = [
  { key: "invoice", name: "Rechnungen", format: "RE-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
  { key: "correction", name: "Rechnungskorrekturen", format: "RK-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
  { key: "quote", name: "Angebote", format: "AN-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
  {
    key: "order_confirmation",
    name: "Auftragsbestätigungen",
    format: "AB-{YYYY}-{####}",
    resetPolicy: "yearly",
    next: 1,
  },
  { key: "delivery_note", name: "Lieferscheine", format: "LS-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
  { key: "proforma", name: "Proforma", format: "PF-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
  { key: "reminder", name: "Mahnungen", format: "MA-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
  { key: "contact", name: "Kontakte", format: "{#####}", resetPolicy: "never", next: 10000 },
  { key: "product", name: "Produkte", format: "ART-{#####}", resetPolicy: "never", next: 1 },
  { key: "asset", name: "Anlagen", format: "AV-{#####}", resetPolicy: "never", next: 1 },
  { key: "voucherInternal", name: "Belege (intern)", format: "BE-{YYYY}-{#####}", resetPolicy: "yearly", next: 1 },
];
