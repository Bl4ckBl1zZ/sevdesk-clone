import { berlinCalendarDate } from "../time/berlin";

/**
 * F02 CON-124: filter the contact timeline (Verlauf) by kind and period and search within the note texts. Pure; the
 * period compares Europe/Berlin calendar days of the entry time, both bounds inclusive.
 */
export type TimelineKind = "note" | "call" | "meeting" | "task" | "derived";

export interface TimelineEntryLike {
  readonly key: string;
  readonly at: number;
  readonly kind: TimelineKind;
  readonly text?: string | undefined;
}

export interface TimelineFilter {
  readonly kind?: TimelineKind | "all" | undefined;
  /** `YYYY-MM-DD`, inclusive; empty = open. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly query?: string | undefined;
}

export function filterTimeline<E extends TimelineEntryLike>(entries: readonly E[], f: TimelineFilter): E[] {
  const q = (f.query ?? "").trim().toLocaleLowerCase("de-DE");
  return entries.filter((e) => {
    if (f.kind && f.kind !== "all" && e.kind !== f.kind) return false;
    const day = berlinCalendarDate(e.at);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    return q === "" || (e.text ?? "").toLocaleLowerCase("de-DE").includes(q);
  });
}
