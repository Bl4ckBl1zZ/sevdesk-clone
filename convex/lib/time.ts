import { TZDate } from "@date-fns/tz";

/** Europe/Berlin wall-clock parts of an instant (crons are registered in UTC; jobs gate on Berlin time). */
export function berlinParts(at: number): { date: string; hour: number; weekday: number } {
  const d = new TZDate(at, "Europe/Berlin");
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hour: d.getHours(),
    weekday: d.getDay(), // 0 = Sunday
  };
}
