import { formatEuro } from "@/domain/money";
import { type CalendarDate, formatGermanDate } from "@/domain/time/calendar-date";

/** "2026-03-10" → "10.03.2026". */
export const dateDe = (iso: string): string => formatGermanDate(iso as CalendarDate);

/** "2026-03" → "03/2026". */
export const periodDe = (period: string): string => `${period.slice(5, 7)}/${period.slice(0, 4)}`;

/** Signed amount with a typographic minus (04-ui-ux §2 number formatting). */
export const euro = (cents: number): string => formatEuro(cents).replace("-", "−");
