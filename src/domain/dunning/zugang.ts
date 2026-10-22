/**
 * Zugang (receipt by the debtor) notices and the manual override rule — F05 PAY-052, PAY-064, EC-DUE-07…09, MAHN-01.
 * The Zugang itself is derived from the manual sent mark in src/domain/documents/dispatch.ts (`zugangFor`, SND-23);
 * this module says what the owner is told about it. Pure; `today` is passed in.
 */
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";

const de = (d: string) => formatGermanDate(d as CalendarDate);

export const ZUGANG_MESSAGES = {
  /** EC-DUE-07 */
  notMarked:
    "Die Rechnung ist nicht als versendet markiert – ohne Zugang beginnt kein Verzug und es wird nicht gemahnt.",
  /** EC-DUE-08 */
  otherChannel: (date: string) => `Zugang angenommen am ${de(date)} (Versandweg ‚Sonstiges‘: + 3 Tage).`,
  /** EC-DUE-10 */
  markRetracted: "Versandmarkierung zurückgenommen – Verzugsbeginn und Mahnplanung wurden zurückgesetzt.",
  /** EC-DUE-09 */
  overrideInvalid: (sentOn: string | undefined) =>
    `Das Zugangsdatum muss zwischen Versanddatum (${sentOn ? de(sentOn) : "–"}) und heute liegen und begründet werden.`,
} as const;

export interface ZugangFacts {
  /** `salesDocuments.zugang` — absent while the document is not marked sent. */
  readonly zugang?: { readonly date: string; readonly basis: string } | null | undefined;
}

export interface ZugangNotice {
  readonly code: "invoice_not_marked_sent" | "zugang_other_channel";
  readonly severity: "W" | "I";
  readonly message: string;
}

/**
 * EC-DUE-07: a finalised invoice without a sent mark has no Zugang → no default, no reminder (warning).
 * EC-DUE-08: a mark with channel `other` assumes the Zugang conservatively 3 days later (info).
 * Otherwise (e-mail, post, hand, portal, manual override) there is nothing to say.
 */
export function zugangNotice(f: ZugangFacts): ZugangNotice | null {
  if (!f.zugang) return { code: "invoice_not_marked_sent", severity: "W", message: ZUGANG_MESSAGES.notMarked };
  if (f.zugang.basis === "other") {
    return { code: "zugang_other_channel", severity: "I", message: ZUGANG_MESSAGES.otherChannel(f.zugang.date) };
  }
  return null;
}

export const OVERRIDE_REASON_MIN_LENGTH = 5;

/** EC-DUE-09: the manual Zugang (Rückschein, confirmation) lies between `sentOn` and today and has a reason. */
export function validateZugangOverride(i: {
  date: string;
  reason: string;
  sentOn?: string | undefined;
  today: string;
}): string | null {
  const ok =
    i.sentOn !== undefined &&
    i.date >= i.sentOn &&
    i.date <= i.today &&
    i.reason.trim().length >= OVERRIDE_REASON_MIN_LENGTH;
  return ok ? null : ZUGANG_MESSAGES.overrideInvalid(i.sentOn);
}
