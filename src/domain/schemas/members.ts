/**
 * Invite form (02 §4.3, 04 §4.10, F12 AUD-022): the shape of the „Person einladen“ dialog and its mapping to the
 * `invites.create` arguments. Time-dependent rules (expiry in the future, ≤ 30 days for auditors) are checked by
 * `validateInviteInput` with the server clock; this schema only checks what the form itself can know.
 */
import { z } from "zod";
import { INVITE_MESSAGES_DE } from "../access/signup";
import { berlinEndOfDay } from "../time/berlin";
import { type CalendarDate, isCalendarDate } from "../time/calendar-date";

export const INVITE_ROLES = ["bookkeeper", "viewer", "auditor"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const inviteSchema = z
  .object({
    email: z.string().trim().regex(EMAIL_RE, INVITE_MESSAGES_DE.invalid_email),
    role: z.enum(INVITE_ROLES),
    /** „Gültig bis“ (YYYY-MM-DD) or empty = unlimited (not allowed for auditors). */
    validUntil: z
      .string()
      .trim()
      .refine((v) => v === "" || isCalendarDate(v), "Bitte ein gültiges Datum angeben."),
    purpose: z.string().trim().max(200),
    organisation: z.string().trim().max(120),
    fiscalYears: z.array(z.number().int().min(2000).max(2100)),
  })
  .superRefine((v, ctx) => {
    if (v.role !== "auditor") return;
    if (v.validUntil === "")
      ctx.addIssue({ code: "custom", path: ["validUntil"], message: INVITE_MESSAGES_DE.auditor_expiry_required });
    if (v.purpose === "")
      ctx.addIssue({
        code: "custom",
        path: ["purpose"],
        message: "Bitte die Prüfungsanordnung bzw. das Aktenzeichen angeben.",
      });
    if (v.fiscalYears.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["fiscalYears"],
        message: "Bitte mindestens ein Wirtschaftsjahr auswählen.",
      });
  });

export type InviteValues = z.infer<typeof inviteSchema>;

export const inviteDefaults: InviteValues = {
  email: "",
  role: "bookkeeper",
  validUntil: "",
  purpose: "",
  organisation: "",
  fiscalYears: [],
};

export interface InviteArgs {
  email: string;
  role: InviteRole;
  memberExpiresAt?: number;
  auditor?: { organisation?: string; purpose: string; fiscalYears: number[] };
}

/** Form values → `invites.create` arguments; „Gültig bis“ ends at 24:00 Berlin time. */
export function inviteArgsFromForm(v: InviteValues): InviteArgs {
  return {
    email: v.email.trim(),
    role: v.role,
    ...(v.validUntil ? { memberExpiresAt: berlinEndOfDay(v.validUntil as CalendarDate) } : {}),
    ...(v.role === "auditor"
      ? {
          auditor: {
            purpose: v.purpose.trim(),
            fiscalYears: [...v.fiscalYears].sort((a, b) => a - b),
            ...(v.organisation.trim() ? { organisation: v.organisation.trim() } : {}),
          },
        }
      : {}),
  };
}

/** Wirtschaftsjahre offered in the dialog: the current and the previous ten (§ 147 AO retention). */
export function selectableFiscalYears(today: CalendarDate): number[] {
  const year = Number(today.slice(0, 4));
  return Array.from({ length: 11 }, (_, i) => year - i);
}
