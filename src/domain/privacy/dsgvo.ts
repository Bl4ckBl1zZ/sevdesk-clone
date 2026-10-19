/**
 * DSGVO tooling (F12 PRV-010…PRV-014, F02 CON-162…CON-165, 01 DSGVO-02/03). Pure: dates are passed in.
 *
 *  - request register: due dates (Art. 12 Abs. 3), extension rules, status machine, reminder stages;
 *  - erasure plan: three buckets — delete now / restrict / purge due date (nothing is purged automatically);
 *  - Art. 15 information (`auskunft.pdf` section model) from the Art. 30 record, response templates.
 *
 * LEGAL-OPEN: F12 open item 4 — staged purge (documents after 8 years, contact anonymisation after the journal's
 * 10 years) is the conservative reading; a data-protection advisor should confirm it.
 */
import type { ImportProtocol, ProtocolSection } from "../import/sevdesk/protocol";
import { shiftToBusinessDay } from "../rules/holidays";
import { RETENTION_CLASS_LABEL_DE, type RetentionClass } from "../rules/retention";
import { type CalendarDate, daysBetween, daysInMonth, formatGermanDate } from "../time/calendar-date";
import type { Art30Record } from "./art30";
import { scheduledPurgeDate } from "./purge";

export const DSGVO_KINDS = ["access", "rectification", "erasure", "restriction", "portability", "objection"] as const;
export type DsgvoKind = (typeof DSGVO_KINDS)[number];

export const DSGVO_KIND_LABEL_DE: Readonly<Record<DsgvoKind, string>> = {
  access: "Auskunft (Art. 15)",
  rectification: "Berichtigung (Art. 16)",
  erasure: "Löschung (Art. 17)",
  restriction: "Einschränkung (Art. 18)",
  portability: "Datenübertragbarkeit (Art. 20)",
  objection: "Widerspruch (Art. 21)",
};

export const DSGVO_CHANNELS = ["email", "post", "phone", "portal", "other"] as const;
export type DsgvoChannel = (typeof DSGVO_CHANNELS)[number];

export const DSGVO_STATUSES = ["open", "in_progress", "extended", "done", "rejected"] as const;
export type DsgvoStatus = (typeof DSGVO_STATUSES)[number];

export const DSGVO_STATUS_LABEL_DE: Readonly<Record<DsgvoStatus, string>> = {
  open: "Offen",
  in_progress: "In Bearbeitung",
  extended: "Verlängert",
  done: "Erledigt",
  rejected: "Abgelehnt",
};

export const DSGVO_MESSAGES = {
  noticeMissing: "Bitte Datum der Mitteilung an die betroffene Person angeben (Art. 12 Abs. 3 DSGVO).",
  reasonMissing: "Bitte geben Sie den Grund der Fristverlängerung an.",
  extensionTooLong: "Die Frist kann um höchstens zwei weitere Monate verlängert werden (Art. 12 Abs. 3 DSGVO).",
  identity: "Identität der anfragenden Person ist nicht bestätigt.",
  rejectionReason: "Bitte geben Sie den Grund der Ablehnung an (Art. 12 Abs. 5 DSGVO).",
  transition: "Dieser Statuswechsel ist nicht möglich.",
  subjectMissing: "Bitte wählen Sie einen Kontakt oder geben Sie den Namen der betroffenen Person an.",
  restricted: "Kontakt ist gesperrt (DSGVO Art. 18) und kann nicht verwendet werden.",
  ownerOnly: "DSGVO-Aktionen sind nur für den Inhaber in der Anwendung möglich.",
} as const;

/** Adds calendar months; a missing day becomes the last day of the target month (E-PRV-14). */
export function addMonthsClamped(date: CalendarDate, months: number): CalendarDate {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + months;
  const ty = y + Math.floor(m / 12);
  const tm = (m % 12) + 1;
  const day = Math.min(Number(date.slice(8, 10)), daysInMonth(ty, tm));
  return `${ty}-${String(tm).padStart(2, "0")}-${String(day).padStart(2, "0")}` as CalendarDate;
}

/**
 * PRV-010 / E-PRV-14: `dueAt` = received + `months` (1, or 2–3 with an extension) on the same calendar day, the last
 * day of the month if it does not exist, moved to the next working day if it is a weekend/holiday (§ 193 BGB analog;
 * `state` = Bundesland of the company for regional holidays).
 */
export function dsgvoDueDate(receivedAt: CalendarDate, state: string | undefined, months = 1): CalendarDate {
  return shiftToBusinessDay(addMonthsClamped(receivedAt, months), state);
}

/** E-PRV-13: an extension (Art. 12 Abs. 3) needs reason, notice date and at most two further months. */
export function extensionIssue(x: { months: number; reason: string; noticeSentOn: string }): string | null {
  if (!x.noticeSentOn.trim()) return DSGVO_MESSAGES.noticeMissing;
  if (!x.reason.trim()) return DSGVO_MESSAGES.reasonMissing;
  if (!Number.isInteger(x.months) || x.months < 1 || x.months > 2) return DSGVO_MESSAGES.extensionTooLong;
  return null;
}

const TRANSITIONS: Readonly<Record<DsgvoStatus, readonly DsgvoStatus[]>> = {
  open: ["in_progress", "extended", "done", "rejected"],
  in_progress: ["extended", "done", "rejected"],
  extended: ["in_progress", "done", "rejected"],
  done: [],
  rejected: [],
};

export const canTransitionRequest = (from: DsgvoStatus, to: DsgvoStatus): boolean => TRANSITIONS[from].includes(to);

/** E-PRV-15: done needs a verified identity; rejected needs a reason (Art. 12 Abs. 5 / identity not verified). */
export function completionIssue(x: {
  to: "done" | "rejected";
  identityVerified: boolean;
  rejectionReason?: string;
}): string | null {
  if (x.to === "rejected") return x.rejectionReason?.trim() ? null : DSGVO_MESSAGES.rejectionReason;
  return x.identityVerified ? null : DSGVO_MESSAGES.identity;
}

/** PRV-010: reminder at due − 7 and due − 1 days; overdue after the due date (E-PRV-12). */
export function reminderStage(dueAt: CalendarDate, today: CalendarDate): "none" | "due7" | "due1" | "overdue" {
  const left = daysBetween(today, dueAt);
  if (left < 0) return "overdue";
  if (left <= 1) return "due1";
  if (left <= 7) return "due7";
  return "none";
}

// ── erasure plan (PRV-011) ─────────────────────────────────────────────────────────────────────────────

export interface ErasureItem {
  kind: string;
  id: string;
  label: string;
}
export interface RetainedItem extends ErasureItem {
  retentionClass: Exclude<RetentionClass, "none">;
  retentionUntil: string;
}

export interface ErasurePlan {
  /** Bucket 1: data without retention duty — deleted at execution. */
  deleteNow: ErasureItem[];
  /** Contact fields without retention duty (notes, birthday, …) — cleared at execution. */
  clearFields: string[];
  /** Bucket 2: retained records — the contact is restricted (Art. 18). */
  restrict: RetainedItem[];
  /** Bucket 3: purge due date per class (manual purge worklist; nothing is purged automatically). */
  byClass: Partial<Record<Exclude<RetentionClass, "none">, CalendarDate>>;
  scheduledPurgeAt: CalendarDate | null;
  /** E-PRV-18: no retained record references the person → the contact itself is deleted. */
  deleteContact: boolean;
}

export function erasurePlan(input: {
  deletable: readonly ErasureItem[];
  retained: readonly RetainedItem[];
  fields: readonly string[];
}): ErasurePlan {
  const byClass: ErasurePlan["byClass"] = {};
  for (const r of input.retained) {
    const due = scheduledPurgeDate([r.retentionUntil]) as CalendarDate;
    const prev = byClass[r.retentionClass];
    if (!prev || due > prev) byClass[r.retentionClass] = due;
  }
  const scheduledPurgeAt = scheduledPurgeDate(input.retained.map((r) => r.retentionUntil));
  return {
    deleteNow: [...input.deletable],
    clearFields: [...input.fields],
    restrict: [...input.retained],
    byClass,
    scheduledPurgeAt,
    deleteContact: input.retained.length === 0,
  };
}

/** E-PRV-17: e-mail addresses of other persons (CC, forwarded mails) are masked in the access export. */
export function maskThirdPartyEmails(text: string, subjectEmails: readonly string[]): string {
  const own = new Set(subjectEmails.map((e) => e.toLowerCase()));
  return text.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (m, first, domain) =>
    own.has(m.toLowerCase()) ? m : `${first}***@${domain}`,
  );
}

// ── Art. 15 information (PRV-013) ──────────────────────────────────────────────────────────────────────

const RIGHTS = [
  "Recht auf Auskunft (Art. 15 DSGVO)",
  "Recht auf Berichtigung (Art. 16 DSGVO)",
  "Recht auf Löschung (Art. 17 DSGVO) — soweit keine gesetzliche Aufbewahrungspflicht besteht (Art. 17 Abs. 3 lit. b DSGVO)",
  "Recht auf Einschränkung der Verarbeitung (Art. 18 DSGVO)",
  "Recht auf Datenübertragbarkeit (Art. 20 DSGVO)",
  "Widerspruchsrecht (Art. 21 DSGVO)",
  "Recht auf Beschwerde bei einer Aufsichtsbehörde (Art. 77 DSGVO)",
];

/** `auskunft.pdf` (section model rendered by src/pdf/import-protocol.tsx's generic section renderer). */
export function auskunftReport(input: {
  record: Art30Record;
  subject: string;
  createdAt: number;
  counts: Readonly<Record<string, number>>;
}): ImportProtocol {
  const r = input.record;
  const sections: ProtocolSection[] = [
    {
      title: "Verantwortlicher",
      paragraphs: [
        [r.controller.name, r.controller.address, r.controller.email].filter(Boolean).join(", "),
        `Datenschutzbeauftragter: ${r.dpo}`,
      ],
    },
    {
      title: "Gespeicherte Daten",
      paragraphs: [
        "Die vollständigen Daten liegen dieser Auskunft als daten.json bei; Belege als PDF/XML im Ordner belege/.",
      ],
      table: {
        headers: ["Kategorie", "Anzahl"],
        rows: Object.entries(input.counts).map(([k, n]) => [k, String(n)]),
        widths: [70, 30],
      },
    },
    {
      title: "Zwecke, Rechtsgrundlagen und Kategorien",
      table: {
        headers: ["Verarbeitung", "Zwecke", "Rechtsgrundlage", "Datenkategorien"],
        rows: r.activities.map((a) => [a.name, a.purpose, a.legalBasis, a.data]),
        widths: [20, 30, 25, 25],
      },
    },
    {
      title: "Empfänger und Auftragsverarbeiter",
      table: {
        headers: ["Verarbeitung", "Empfänger", "Übermittlung in Drittländer"],
        rows: r.activities.map((a) => [a.name, a.recipients, a.thirdCountry]),
        widths: [25, 45, 30],
      },
    },
    {
      title: "Speicherdauer",
      paragraphs: [
        `${RETENTION_CLASS_LABEL_DE.books10}: Buchungen, Konten, Steuererklärungen, Protokoll.`,
        `${RETENTION_CLASS_LABEL_DE.vouchers8}: Rechnungen, Gutschriften, Eingangsbelege, Zahlungen, Bankumsätze.`,
        `${RETENTION_CLASS_LABEL_DE.letters6}: Angebote, Geschäftsbriefe, Versandprotokolle.`,
        "Die Frist beginnt mit dem Ende des Kalenderjahres des Belegs (§ 147 Abs. 4 AO). Danach werden die Daten gelöscht.",
      ],
    },
    {
      title: "Herkunft der Daten",
      paragraphs: [
        "Die Daten stammen von Ihnen selbst (Auftrag, Korrespondenz, Zahlungen) oder aus Kontoauszügen unserer Bank.",
      ],
    },
    { title: "Ihre Rechte", paragraphs: RIGHTS },
  ];
  return {
    title: "Auskunft nach Art. 15 DSGVO",
    subtitle: `Betroffene Person: ${input.subject} · erstellt am ${formatGermanDate(
      new Date(input.createdAt).toISOString().slice(0, 10) as CalendarDate,
    )}`,
    fileName: "auskunft.pdf",
    createdAt: input.createdAt,
    sections,
    footer: `${r.controller.name} · Auskunft nach Art. 15 DSGVO`,
  };
}

/** PRV-011/PRV-014: response letter templates (the owner sends them; the app has no e-mail sending). */
export function responseTemplate(
  kind: DsgvoKind,
  x: { name: string; company: string; purgeDate?: string | null; openAmount?: string },
): string {
  const head = `Sehr geehrte(r) ${x.name},\n\n`;
  const foot = `\n\nMit freundlichen Grüßen\n${x.company}`;
  switch (kind) {
    case "rectification":
      return `${head}wir haben Ihre Stammdaten wie gewünscht berichtigt. Bitte beachten Sie: bereits ausgestellte Rechnungen bleiben unverändert, weil sie nach den Grundsätzen ordnungsmäßiger Buchführung (GoBD) unveränderlich aufbewahrt werden müssen. Ist eine an Sie ausgestellte Rechnung inhaltlich fehlerhaft, stellen wir Ihnen gern eine Rechnungsberichtigung aus.${foot}`;
    case "erasure": {
      const until = x.purgeDate ? formatGermanDate(x.purgeDate as CalendarDate) : null;
      const retained = until
        ? ` Rechnungen und Buchungen müssen wir nach § 147 AO und § 14b UStG aufbewahren (Art. 17 Abs. 3 lit. b DSGVO). Diese Daten wurden gesperrt, werden nicht mehr verarbeitet und nach Ablauf der Aufbewahrungsfrist ab dem ${until} gelöscht.`
        : " Es bestehen keine Aufbewahrungspflichten; Ihre Daten wurden vollständig gelöscht.";
      const claims = x.openAmount
        ? ` Offene Forderungen (${x.openAmount} €) dürfen wir weiter geltend machen (Art. 18 Abs. 2 DSGVO).`
        : "";
      return `${head}wir haben Ihren Antrag auf Löschung bearbeitet. Daten ohne Aufbewahrungspflicht (z. B. Notizen, Entwürfe) wurden gelöscht.${retained}${claims}${foot}`;
    }
    case "restriction":
      return `${head}wir haben die Verarbeitung Ihrer Daten eingeschränkt (Art. 18 DSGVO). Sie werden nur noch gespeichert und für gesetzliche Pflichten (Aufbewahrung, Prüfung durch das Finanzamt) verwendet.${foot}`;
    case "access":
    case "portability":
      return `${head}anbei erhalten Sie die Auskunft über die zu Ihrer Person gespeicherten Daten (auskunft.pdf) sowie die Daten in einem maschinenlesbaren Format (daten.json).${foot}`;
    case "objection":
      return `${head}wir haben Ihren Widerspruch erhalten und verarbeiten Ihre Daten nur noch, soweit wir dazu gesetzlich verpflichtet sind.${foot}`;
  }
}
