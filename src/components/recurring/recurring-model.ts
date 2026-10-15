/**
 * Recurring template editor state (F04 §6.5): the invoice editor state for the content plus the „Zeitplan“ and
 * „Automatik“ sections. Only parsing — schedule rules, totals and validation run in Convex with the domain functions.
 */
import type { BillingMode, RecurringInterval } from "@/domain/recurring/schedule";
import type { RecurringTemplateValues, TemplateDraftValues } from "@/domain/schemas/recurring";
import type { CalendarDate } from "@/domain/time/calendar-date";
import {
  type EditorError,
  type EditorState,
  editorFromValues,
  emptyEditor,
  toDraftValues,
} from "../invoices/editor-model";

export type EndMode = "never" | "date" | "count";

export interface RecurringFormState {
  readonly name: string;
  readonly contractReference: string;
  readonly interval: RecurringInterval;
  readonly firstDate: string;
  readonly billing: BillingMode;
  readonly endMode: EndMode;
  readonly endDate: string;
  readonly maxCount: string;
  readonly periodText: boolean;
  readonly finalize: boolean;
  readonly editor: EditorState;
}

export function emptyRecurringForm(firstDate: string, contactId = ""): RecurringFormState {
  return {
    name: "",
    contractReference: "",
    interval: "P1M",
    firstDate,
    billing: "in_advance",
    endMode: "never",
    endDate: "",
    maxCount: "",
    periodText: true,
    finalize: false,
    editor: emptyEditor(firstDate, { type: "invoice", contactId }),
  };
}

export function recurringFormFrom(v: RecurringTemplateValues): RecurringFormState {
  const s = v.schedule;
  return {
    name: v.name,
    contractReference: v.contractReference ?? "",
    interval: s.interval,
    firstDate: s.firstDate,
    billing: s.billing,
    endMode: s.endDate ? "date" : s.maxCount !== undefined ? "count" : "never",
    endDate: s.endDate ?? "",
    maxCount: s.maxCount !== undefined ? String(s.maxCount) : "",
    periodText: s.periodTextEnabled,
    finalize: v.automation.finalize,
    editor: editorFromValues({
      ...v.draft,
      supplyDateMode: "explicit",
      supplyDate: { kind: "date", date: s.firstDate as CalendarDate },
    }),
  };
}

/** Form → template values (shared `recurringTemplateSchema`); input errors are returned for the fields. */
export function toTemplateValues(f: RecurringFormState): { values: RecurringTemplateValues; errors: EditorError[] } {
  const { values: draftValues, errors } = toDraftValues({ ...f.editor, type: "invoice", supplyDateMode: "explicit" });
  const {
    supplyDate: _s,
    supplyDateMode: _m,
    documentDate: _d,
    backdateReason: _b,
    chainOrder: _c,
    validUntil: _v,
    deliveryTerms: _t,
    showPrices: _p,
    ...draft
  } = draftValues;
  if (!f.name.trim()) errors.push({ field: "name", message: "Bitte einen Namen angeben." });
  if (!f.firstDate) errors.push({ field: "firstDate", message: "Bitte das Datum der ersten Rechnung angeben." });
  const maxCount = f.endMode === "count" ? Number.parseInt(f.maxCount, 10) : undefined;
  if (f.endMode === "count" && (!Number.isInteger(maxCount) || (maxCount ?? 0) < 1)) {
    errors.push({ field: "maxCount", message: "Anzahl der Rechnungen ungültig." });
  }
  if (f.endMode === "date" && !f.endDate) errors.push({ field: "endDate", message: "Bitte ein Enddatum angeben." });
  const values: RecurringTemplateValues = {
    name: f.name.trim(),
    ...(f.contractReference.trim() ? { contractReference: f.contractReference.trim() } : {}),
    draft: { ...(draft as TemplateDraftValues), type: "invoice" },
    schedule: {
      interval: f.interval,
      firstDate: f.firstDate as CalendarDate,
      ...(f.endMode === "date" && f.endDate ? { endDate: f.endDate as CalendarDate } : {}),
      ...(f.endMode === "count" && maxCount && maxCount >= 1 ? { maxCount } : {}),
      billing: f.billing,
      periodTextEnabled: f.periodText,
    },
    automation: { finalize: f.finalize },
  };
  return { values, errors };
}
