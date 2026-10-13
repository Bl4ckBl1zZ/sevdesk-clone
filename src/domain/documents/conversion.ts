/**
 * Conversions between sales documents (F04 §4.3, DOC-33, QUO-06…13): the matrix of allowed (source, target) pairs,
 * the source guards, the copy rules of §4.3.2 for the lines, the collective invoice from delivery notes (QUO-11) and
 * quote revisions (QUO-06). Pure: the model layer reads the source documents and the chain progress
 * (`./progress.ts`) and writes the new draft.
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import { addDays, type CalendarDate, formatGermanDate } from "../time/calendar-date";
import { DOC_TYPE_LABEL_DE } from "./doc-types";
import type { DraftDocument, DraftLine } from "./draft";
import type { LifecycleEvent, SalesDocStatus } from "./lifecycle";
import type { SalesDocType, SupplyDate } from "./snapshot";

/** §4.3.1 (source must be finalised; quote → quote is the revision of QUO-06, see `reviseQuote`). */
export const CONVERSION_MATRIX: Readonly<Partial<Record<SalesDocType, readonly SalesDocType[]>>> = {
  quote: [
    "order_confirmation",
    "delivery_note",
    "proforma",
    "invoice",
    "advance_invoice",
    "partial_invoice",
    "final_invoice",
  ],
  order_confirmation: ["delivery_note", "proforma", "invoice", "advance_invoice", "partial_invoice", "final_invoice"],
  delivery_note: ["invoice"],
  proforma: ["invoice"],
  invoice: ["delivery_note"],
};

const INVOICE_TARGETS: readonly SalesDocType[] = ["invoice", "advance_invoice", "partial_invoice", "final_invoice"];

/** Statuses from which nothing can be converted any more (withdrawn, replaced, rejected). */
const DEAD: readonly SalesDocStatus[] = ["cancelled", "superseded", "rejected", "withdrawn"];

const STATUS_DE: Partial<Record<SalesDocStatus, string>> = {
  cancelled: "storniert/zurückgezogen",
  superseded: "durch eine neue Version ersetzt",
  rejected: "abgelehnt",
  withdrawn: "widerrufen",
};

export interface ConversionSource {
  readonly type: SalesDocType;
  readonly status: SalesDocStatus;
  readonly number?: string | undefined;
}

export interface ConversionCheck {
  /** Converting a finalised/sent/expired quote into an order or invoice first records the acceptance (§4.2.1). */
  readonly acceptEvent?: Extract<LifecycleEvent, "accept" | "accept_late"> | undefined;
}

/** §4.3.1 + §5.1.6 guards: `source_not_finalized`, `conversion_not_allowed`, `source_already_invoiced`. */
export function checkConversion(source: ConversionSource, target: SalesDocType): Result<ConversionCheck, Issue> {
  const label = source.number ?? DOC_TYPE_LABEL_DE[source.type];
  if (source.status === "draft") {
    return err(issue("source_not_finalized", "Nur fertiggestellte Dokumente können umgewandelt werden."));
  }
  if (!CONVERSION_MATRIX[source.type]?.includes(target)) {
    return err(
      issue(
        "conversion_not_allowed",
        `Aus ${DOC_TYPE_LABEL_DE[source.type]} kann kein(e) ${DOC_TYPE_LABEL_DE[target]} erstellt werden.`,
        { sourceType: source.type, targetType: target },
      ),
    );
  }
  if (DEAD.includes(source.status)) {
    return err(
      issue("conversion_not_allowed", `${label} ist ${STATUS_DE[source.status]} und kann nicht umgewandelt werden.`, {
        sourceType: source.type,
        targetType: target,
      }),
    );
  }
  if (source.status === "invoiced" && INVOICE_TARGETS.includes(target) && source.type !== "delivery_note") {
    // EC-DOC-102: a proforma (or a fully billed quote/order) is not invoiced twice.
    return err(issue("source_already_invoiced", `${label} ist bereits vollständig berechnet.`, { number: label }));
  }
  if (source.type === "quote" && (target === "order_confirmation" || INVOICE_TARGETS.includes(target))) {
    if (source.status === "finalized" || source.status === "sent") return ok({ acceptEvent: "accept" });
    if (source.status === "expired") return ok({ acceptEvent: "accept_late" });
  }
  return ok({});
}

// ── copy rules (§4.3.2) ─────────────────────────────────────────────────────────────────────────────────────────

export interface SourceLine extends DraftLine {
  readonly id: string;
}

export interface ConvertOptions {
  /** `full` = every line with its remaining (or full) quantity; `quantities` = only the given quantities. */
  readonly mode?: "full" | "quantities" | undefined;
  /** Quantities per source line id (`quantities` mode; also overrides single lines in `full` mode). */
  readonly quantities?: Readonly<Record<string, number>> | undefined;
  /** Optional quote lines the customer chose (QUO-02); others are dropped, the flag is removed. */
  readonly optionalLineIds?: readonly string[] | undefined;
  /** Quantity not yet billed/delivered per source line (QUO-10, INV-05); proposed instead of the full quantity. */
  readonly remaining?: Readonly<Record<string, number>> | undefined;
}

/** Header fields a conversion copies (§4.3.2): parties, terms, references, texts; never number, dates or status. */
export type ConvertibleHeader = Omit<DraftDocument, "type" | "lines" | "documentDate" | "backdateReason">;

export interface ConvertedDraft extends Omit<DraftDocument, "lines"> {
  readonly lines: readonly DraftLine[];
}

const strip = <T extends object>(o: T, keys: readonly string[]): T => {
  const out = { ...o } as Record<string, unknown>;
  for (const k of keys) delete out[k];
  return out as T;
};

/** Lines of the target draft: references to the source lines, quantities per the dialog, optional lines chosen. */
export function convertLines(lines: readonly SourceLine[], o: ConvertOptions = {}): DraftLine[] {
  const chosen = new Set(o.optionalLineIds ?? []);
  const out: DraftLine[] = [];
  for (const l of lines) {
    const { id, ...line } = l;
    if (l.kind !== "item") {
      out.push(strip(line, ["optional", "sourceLineId"]));
      continue;
    }
    if (l.optional && !chosen.has(id)) continue;
    const proposed = o.remaining?.[id] ?? l.quantityMilli ?? 0;
    const given = o.quantities?.[id];
    const quantityMilli = o.mode === "quantities" ? (given ?? 0) : (given ?? proposed);
    if (quantityMilli === 0) continue;
    out.push({
      ...strip(line, ["optional", "sourceLineId"]),
      quantityMilli,
      sourceLineId: id,
    });
  }
  // Headings/texts/subtotals that end up without any item below them stay: they are part of the source layout.
  return out;
}

/** §4.3.2 supply date: delivery note → invoice uses the delivery date; otherwise copied if set. */
export function convertedSupply(
  source: Pick<DraftDocument, "supplyDate" | "supplyDateMode"> & { readonly type: SalesDocType },
  target: SalesDocType,
): Pick<DraftDocument, "supplyDate" | "supplyDateMode"> {
  if (source.supplyDate) return { supplyDate: source.supplyDate, supplyDateMode: "explicit" };
  // A delivery note needs a delivery date (QUO-09): default „Lieferdatum = Dokumentdatum“.
  if (target === "delivery_note" || source.supplyDateMode === "document_date")
    return { supplyDateMode: "document_date" };
  return { supplyDateMode: "explicit" };
}

/** The target draft of a single-source conversion (§4.3.2). Tax case and rates are re-derived on save (EC-040/080). */
export function convertDocument(
  source: Omit<DraftDocument, "lines"> & { readonly lines: readonly SourceLine[] },
  target: SalesDocType,
  o: ConvertOptions = {},
): ConvertedDraft {
  const keepTerms = target === "quote" || target === "order_confirmation";
  const header = strip(source as Omit<DraftDocument, "lines"> & { lines: unknown }, [
    ...(keepTerms ? [] : ["deliveryTerms"]),
    "type",
    "lines",
    "documentDate",
    "backdateReason",
    "supplyDate",
    "supplyDateMode",
    "fxRateToEur",
    "validUntil",
    "showPrices",
    "einvoiceFormat",
  ]) as ConvertibleHeader;
  return {
    ...header,
    type: target,
    ...convertedSupply(source, target),
    lines: convertLines(source.lines, o),
  };
}

// ── collective invoice (QUO-11) ─────────────────────────────────────────────────────────────────────────────────

export interface CollectiveSource extends ConvertibleHeader {
  readonly id: string;
  readonly type: SalesDocType;
  readonly status: SalesDocStatus;
  readonly number: string;
  readonly contactId?: string | undefined;
  readonly taxCase: string;
  /** Delivery date (supply date) of the note. */
  readonly deliveryDate: string;
  readonly lines: readonly SourceLine[];
}

/** `collective_mismatch` (contact, currency, tax case, price mode) and the source guards for each note. */
export function checkCollective(notes: readonly CollectiveSource[]): Result<void, Issue> {
  if (notes.length === 0) return err(issue("collective_mismatch", "Bitte mindestens einen Lieferschein wählen."));
  for (const n of notes) {
    const c = checkConversion(n, "invoice");
    if (!c.ok) return c;
    if (n.type !== "delivery_note") {
      return err(issue("conversion_not_allowed", "Eine Sammelrechnung entsteht nur aus Lieferscheinen."));
    }
  }
  const first = notes[0] as CollectiveSource;
  const fields: [keyof CollectiveSource, string][] = [
    ["contactId", "Kunde"],
    ["currency", "Währung"],
    ["taxCase", "Steuerfall"],
    ["priceMode", "Netto/Brutto"],
  ];
  for (const [key, label] of fields) {
    if (notes.some((n) => n[key] !== first[key])) {
      return err(
        issue("collective_mismatch", `Die gewählten Lieferscheine passen nicht zusammen (${label}).`, { field: label }),
      );
    }
  }
  return ok(undefined);
}

/**
 * QUO-11: one invoice draft with a heading per delivery note („Lieferschein LS-2026-0012 vom 03.10.2026“), each item
 * dated with its note's delivery date (BG-26), and the supply period from the earliest to the latest delivery date.
 */
export function collectiveInvoice(notes: readonly CollectiveSource[]): ConvertedDraft {
  const sorted = [...notes].sort((a, b) =>
    a.deliveryDate === b.deliveryDate ? a.number.localeCompare(b.number) : a.deliveryDate < b.deliveryDate ? -1 : 1,
  );
  const first = sorted[0] as CollectiveSource;
  const last = sorted.at(-1) as CollectiveSource;
  const lines: DraftLine[] = [];
  for (const n of sorted) {
    lines.push({
      kind: "heading",
      name: `Lieferschein ${n.number} vom ${formatGermanDate(n.deliveryDate as CalendarDate)}`,
    });
    for (const l of convertLines(n.lines)) {
      lines.push(l.kind === "item" ? { ...l, linePeriod: { from: n.deliveryDate, to: n.deliveryDate } } : l);
    }
  }
  const supplyDate: SupplyDate =
    first.deliveryDate === last.deliveryDate
      ? { kind: "date", date: first.deliveryDate }
      : { kind: "period", from: first.deliveryDate, to: last.deliveryDate };
  const base = convertDocument(first, "invoice");
  return { ...base, supplyDate, supplyDateMode: "explicit", lines };
}

// ── quote revisions (QUO-06, QUO-07) ────────────────────────────────────────────────────────────────────────────

/** QUO-06 `quoteRevisionNumbering: suffix`: the base number of revision 1 plus `-V{n}`. */
export const revisionNumber = (baseNumber: string, revision: number): string => `${baseNumber}-V${revision}`;

/** QUO-06/07: which quotes may get a new version. */
export function checkRevision(source: ConversionSource): Result<void, Issue> {
  if (source.type !== "quote") return err(issue("conversion_not_allowed", "Neue Versionen gibt es nur für Angebote."));
  if (source.status === "draft") {
    return err(issue("source_not_finalized", "Nur fertiggestellte Dokumente können umgewandelt werden."));
  }
  if (source.status === "accepted" || source.status === "partially_invoiced" || source.status === "invoiced") {
    return err(
      issue(
        "quote_accepted_frozen",
        "Das Angebot wurde angenommen und ist eingefroren. Für Änderungen bitte ein neues Angebot oder einen Nachtrag erstellen.",
      ),
    );
  }
  // US-02 / T-QUO-004: a rejected quote may get a new version; withdrawn and replaced ones not.
  if (source.status !== "rejected" && DEAD.includes(source.status)) {
    return err(
      issue(
        "conversion_not_allowed",
        `${source.number ?? "Das Angebot"} ist ${STATUS_DE[source.status]}; eine neue Version ist nicht möglich.`,
      ),
    );
  }
  return ok(undefined);
}

/** The revision draft: the full content of the previous version (incl. optional lines), new validity at finalisation. */
export function reviseQuote(source: ConvertibleHeader & { readonly lines: readonly SourceLine[] }): ConvertedDraft {
  const header = strip(source as ConvertibleHeader & { lines: unknown }, [
    "lines",
    "documentDate",
    "backdateReason",
    "validUntil",
    "fxRateToEur",
  ]) as ConvertibleHeader;
  return {
    ...header,
    type: "quote",
    lines: source.lines.map(({ id: _id, ...l }) => strip(l, ["sourceLineId"])),
  };
}

// ── quote deadlines (QUO-04) ────────────────────────────────────────────────────────────────────────────────────

export interface QuoteDeadlineRow {
  readonly id: string;
  readonly status: SalesDocStatus;
  readonly validUntil?: string | undefined;
}

/** `deadlines.notify`: `finalized`/`sent` quotes past `validUntil` expire; 3 days before expiry a reminder is due. */
export function quoteDeadlines(
  quotes: readonly QuoteDeadlineRow[],
  today: string,
): { expire: string[]; remind: string[] } {
  const expire: string[] = [];
  const remind: string[] = [];
  for (const q of quotes) {
    if ((q.status !== "finalized" && q.status !== "sent") || !q.validUntil) continue;
    if (q.validUntil < today) expire.push(q.id);
    else if (today >= addDays(q.validUntil as CalendarDate, -3)) remind.push(q.id);
  }
  return { expire, remind };
}

// ── acceptance / rejection input (QUO-05) ───────────────────────────────────────────────────────────────────────

export interface AcceptanceInput {
  readonly date: string;
  readonly byName: string;
  readonly channel: "manual" | "email" | "phone";
  readonly note?: string | undefined;
  /** „Angebot ist abgelaufen – trotzdem annehmen?“ confirmed (§4.2.1). */
  readonly late?: boolean | undefined;
}

/** QUO-05: date (≤ today), by whom; an expired quote needs the explicit confirmation. */
export function checkAcceptance(
  quote: { readonly status: SalesDocStatus; readonly validUntil?: string | undefined },
  input: AcceptanceInput,
  today: string,
): Result<Extract<LifecycleEvent, "accept" | "accept_late">, Issue> {
  if (input.date > today) return err(issue("acceptance_date_future", "Das Datum darf nicht in der Zukunft liegen."));
  if (!input.byName.trim()) return err(issue("acceptance_name_missing", "Bitte angeben, wer angenommen hat."));
  if (quote.status === "expired") {
    if (!input.late) {
      return err(
        issue(
          "quote_expired_notice",
          `Das Angebot ist am ${formatGermanDate((quote.validUntil ?? today) as CalendarDate)} abgelaufen. Trotzdem annehmen?`,
        ),
      );
    }
    return ok("accept_late");
  }
  return ok("accept");
}
