import { z } from "zod";
import { MAX_RATE_LIMIT_PER_MINUTE, MIN_RATE_LIMIT_PER_MINUTE } from "../api/rate-limit";
import { isGrantableScope } from "../api/scopes";
import { type CalendarDate, isCalendarDate } from "../time/calendar-date";

/**
 * „API-Schlüssel erstellen" (05 §2.1): name, channel, scopes (≥ 1, grantable only), optional expiry date (Berlin,
 * valid through the end of that day; must be after `today` — checked on the server with `validateExpiry`), optional
 * rate limit per minute. Shared by the dialog and the Convex action.
 */
export const API_KEY_CHANNELS = ["api", "mcp", "both"] as const;
export type ApiKeyChannel = (typeof API_KEY_CHANNELS)[number];

export const API_KEY_CHANNEL_LABELS: Readonly<Record<ApiKeyChannel, string>> = {
  api: "REST-API",
  mcp: "MCP (Claude)",
  both: "REST-API und MCP",
};

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1, "Bitte einen Namen angeben.").max(60, "Der Name darf höchstens 60 Zeichen lang sein."),
  channel: z.enum(API_KEY_CHANNELS),
  scopes: z
    .array(z.string())
    .min(1, "Bitte mindestens eine Berechtigung wählen.")
    .refine((s) => s.every(isGrantableScope), "Diese Berechtigung kann nicht vergeben werden.")
    .transform((s) => [...new Set(s)].sort()),
  /** "" = no expiry. */
  expiresOn: z
    .string()
    .trim()
    .refine((v) => v === "" || isCalendarDate(v), "Ungültiges Datum."),
  /** "" = default (120/min). */
  rateLimitPerMinute: z
    .string()
    .trim()
    .refine(
      (v) =>
        v === "" ||
        (/^\d+$/.test(v) && Number(v) >= MIN_RATE_LIMIT_PER_MINUTE && Number(v) <= MAX_RATE_LIMIT_PER_MINUTE),
      `Bitte eine Zahl zwischen ${MIN_RATE_LIMIT_PER_MINUTE} und ${MAX_RATE_LIMIT_PER_MINUTE} angeben.`,
    ),
});
export type ApiKeyCreateFormValues = z.input<typeof apiKeyCreateSchema>;
export type ApiKeyCreateValues = z.output<typeof apiKeyCreateSchema>;

/** The expiry must lie after today (Berlin). */
export function validateExpiry(expiresOn: string, today: CalendarDate): string | null {
  if (expiresOn === "") return null;
  return expiresOn > today ? null : "Das Ablaufdatum muss in der Zukunft liegen.";
}
