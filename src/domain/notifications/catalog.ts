/**
 * Notification kinds catalog and channel rules (F12 §4.8, NTF-001…006). Pure: no I/O, `now` passed in.
 *
 * - Every kind has a default severity, default channels and a data-minimal text for ntfy/e-mail (NTF-004, DSGVO-05:
 *   no customer names or amounts unless the owner enables „Details senden").
 * - `critical` kinds cannot be switched off for in-app and e-mail (NTF-002, E-NTF-02).
 * - Kinds outside the catalog (the F04/F05 to-dos such as `exported_not_marked`) are in-app only.
 */

export type NotificationSeverity = "info" | "warning" | "error" | "critical";

export interface NotificationChannels {
  readonly inApp: boolean;
  readonly email: boolean;
  readonly ntfy: boolean;
  readonly digest: boolean;
}

export interface NotificationKindDef {
  readonly severity: NotificationSeverity;
  readonly channels: NotificationChannels;
  /** Data-minimal text for ntfy/e-mail (NTF-003/004). */
  readonly minimal: string;
  /** German label for the channel matrix. */
  readonly label: string;
}

const ALARM: NotificationChannels = { inApp: true, email: true, ntfy: true, digest: false };
const DEADLINE: NotificationChannels = { inApp: true, email: false, ntfy: true, digest: true };
const WATCH: NotificationChannels = { inApp: true, email: false, ntfy: false, digest: true };
const INFO: NotificationChannels = { inApp: true, email: false, ntfy: false, digest: false };

const def = (
  severity: NotificationSeverity,
  channels: NotificationChannels,
  label: string,
  minimal: string,
): NotificationKindDef => ({ severity, channels, label, minimal });

export const NOTIFICATION_KINDS = {
  // critical · in-app, e-mail, ntfy
  "integrity.failed": def(
    "critical",
    ALARM,
    "Integritätsprüfung fehlgeschlagen",
    "Integritätsprüfung fehlgeschlagen – Details in der App",
  ),
  "checkpoint.upload_failed": def(
    "critical",
    ALARM,
    "Prüfpunkt-Upload fehlgeschlagen",
    "Prüfpunkt konnte nicht hochgeladen werden – Details in der App",
  ),
  "access.misconfigured": def(
    "critical",
    ALARM,
    "Zugriff falsch konfiguriert",
    "Zugriffskonfiguration fehlerhaft – Details in der App",
  ),
  "clock.skew_critical": def(
    "critical",
    ALARM,
    "Serverzeit weicht ab",
    "Serverzeit weicht ab – Fertigstellen gesperrt",
  ),
  // error · in-app, e-mail, ntfy
  "backup.stale": def("error", ALARM, "Datensicherung veraltet", "Datensicherung veraltet – Details in der App"),
  "restore_drill.overdue": def(
    "error",
    ALARM,
    "Wiederherstellungstest überfällig",
    "Wiederherstellungstest überfällig",
  ),
  "einvoice_tools.down": def(
    "error",
    ALARM,
    "E-Rechnungs-Prüfdienst nicht erreichbar",
    "E-Rechnungs-Prüfdienst nicht erreichbar",
  ),
  "artifact.blocked": def(
    "error",
    ALARM,
    "Archivdatei blockiert",
    "Archivdatei konnte nicht erzeugt werden – Details in der App",
  ),
  "auth_mail.failed": def(
    "error",
    ALARM,
    "Anmelde-E-Mail fehlgeschlagen",
    "Anmelde-E-Mail konnte nicht gesendet werden",
  ),
  "bank.reauth_required": def("error", ALARM, "Bankverbindung erneuern", "Bankverbindung muss erneuert werden"),
  // F12 E-PRV-12: a DSGVO request not answered by its due date (error; the warning `dsgvo.deadline` precedes it)
  "dsgvo.overdue": def("error", ALARM, "DSGVO-Anfrage überfällig", "Eine Datenschutzanfrage ist überfällig"),
  // warning · in-app, digest, ntfy
  "deadline.ustva": def("warning", DEADLINE, "Frist Umsatzsteuer-Voranmeldung", "Frist Umsatzsteuer-Voranmeldung naht"),
  "deadline.zm": def("warning", DEADLINE, "Frist Zusammenfassende Meldung", "Frist Zusammenfassende Meldung naht"),
  "deadline.14a": def("warning", DEADLINE, "Frist § 14a UStG", "Rechnungsfrist nach § 14a UStG naht"),
  "deadline.vorauszahlung": def("warning", DEADLINE, "Steuervorauszahlung fällig", "Steuervorauszahlung bald fällig"),
  // F08 TAX-019: annual returns for self-filers (no Steuerberater, B5), reminders 6 and 1 weeks before.
  "deadline.annual_return": def("warning", DEADLINE, "Frist Steuererklärung", "Frist für eine Steuererklärung naht"),
  "dsgvo.deadline": def("warning", DEADLINE, "DSGVO-Frist", "Frist für eine Datenschutzanfrage naht"),
  // F08 ACC-018: an open month older than 2 months → Festschreibung reminder
  "deadline.period_lock": def("warning", DEADLINE, "Festschreibung empfohlen", "Monate sollten festgeschrieben werden"),
  "uninvoiced.150d": def(
    "warning",
    DEADLINE,
    "Leistung seit 150 Tagen nicht abgerechnet",
    "Nicht abgerechnete Leistung – Details in der App",
  ),
  // warning · in-app, digest
  "threshold.ku": def("warning", WATCH, "Kleinunternehmergrenze", "Kleinunternehmergrenze bald erreicht"),
  "threshold.800k": def("warning", WATCH, "Umsatzgrenze 800.000 €", "Umsatzgrenze 800.000 € – Details in der App"),
  "threshold.oss": def("warning", WATCH, "OSS-Lieferschwelle", "OSS-Lieferschwelle – Details in der App"),
  "project.budget": def("warning", WATCH, "Projektbudget", "Projektbudget überschritten"),
  // F03 PRD-096: one notification per product while the stock is below its reorder level (e-mail if enabled).
  "stock.low": def(
    "warning",
    WATCH,
    "Mindestbestand unterschritten",
    "Mindestbestand unterschritten – Details in der App",
  ),
  // F11 PRJ-005 / E-PRJ-03: a timer running for 10 hours; auto-stopped after 24 hours.
  "timer.long": def("warning", INFO, "Timer läuft lange", "Ein Timer läuft seit über 10 Stunden"),
  "rules.stale": def("warning", WATCH, "Regeln veraltet", "Steuerregeln sollten aktualisiert werden"),
  "api_key.expiring": def("warning", WATCH, "API-Schlüssel läuft ab", "API-Schlüssel läuft bald ab"),
  "bank.consent_expiring": def("warning", WATCH, "Bankzugriff läuft ab", "Bankzugriff läuft bald ab"),
  "member.expiring": def("warning", WATCH, "Zugang läuft ab", "Ein Zugang läuft bald ab"),
  "cert.expiring": def("warning", WATCH, "Zertifikat läuft ab", "Ein Zertifikat läuft bald ab"),
  "verfahrensdoku.outdated": def(
    "warning",
    WATCH,
    "Verfahrensdokumentation veraltet",
    "Verfahrensdokumentation muss aktualisiert werden",
  ),
  "retention.purge_eligible": def(
    "warning",
    WATCH,
    "Aufbewahrungsfrist abgelaufen",
    "Datensätze können gelöscht werden",
  ),
  "period.unlocked_old": def(
    "warning",
    WATCH,
    "Alter Zeitraum offen",
    "Ein alter Buchungszeitraum ist nicht festgeschrieben",
  ),
  "ntfy.failed": def(
    "warning",
    WATCH,
    "ntfy nicht erreichbar",
    "ntfy-Benachrichtigungen konnten nicht zugestellt werden.",
  ),
  // info · in-app
  "quote.accepted": def("info", INFO, "Angebot angenommen", "Angebot angenommen – Details in der App"),
  "quote.declined": def("info", INFO, "Angebot abgelehnt", "Angebot abgelehnt – Details in der App"),
  "invoice.paid": def("info", INFO, "Rechnung bezahlt", "Rechnung bezahlt – Details in der App"),
  "payment.received": def("info", INFO, "Zahlung eingegangen", "Zahlung eingegangen – Details in der App"),
  "inbox.new": def("info", INFO, "Neuer Beleg im Posteingang", "Neuer Beleg im Posteingang"),
  "inbox.needs_review": def("info", INFO, "Beleg prüfen", "Ein Beleg muss geprüft werden"),
  "export.ready": def("info", INFO, "Export bereit", "Export bereit – Details in der App"),
  "import.finished": def("info", INFO, "Import abgeschlossen", "Import abgeschlossen"),
  "auditor.first_access": def("info", INFO, "Erster Prüferzugriff", "Ein Prüfer hat sich erstmals angemeldet"),
  "member.joined": def("info", INFO, "Neues Mitglied", "Ein neues Mitglied ist beigetreten"),
} as const satisfies Record<string, NotificationKindDef>;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

/** Existing to-do kinds (F04/F05) that are the same event as a catalog kind. */
const ALIASES: Readonly<Record<string, NotificationKind>> = { artifacts_blocked: "artifact.blocked" };

export const isCatalogKind = (kind: string): kind is NotificationKind => kind in NOTIFICATION_KINDS;

export function kindDef(kind: string): NotificationKindDef | null {
  const k = ALIASES[kind] ?? kind;
  return isCatalogKind(k) ? NOTIFICATION_KINDS[k] : null;
}

export const NTF02_MESSAGE = "Kritische Meldungen können nicht abbestellt werden.";

/** Effective channels for a kind: catalog default, then the owner's matrix; critical keeps in-app + e-mail. */
export function channelsFor(
  kind: string,
  severity: NotificationSeverity,
  matrix: Readonly<Record<string, NotificationChannels>> = {},
): NotificationChannels {
  const d = kindDef(kind);
  const base = matrix[ALIASES[kind] ?? kind] ?? d?.channels ?? INFO;
  return severity === "critical" || d?.severity === "critical" ? { ...base, inApp: true, email: true } : base;
}

/** E-NTF-02: a matrix change that switches off in-app or e-mail for a critical kind is refused. */
export function checkChannelChange(
  kind: string,
  channels: NotificationChannels,
): { ok: true } | { ok: false; error: string } {
  if (!isCatalogKind(kind)) return { ok: false, error: `Unbekannte Benachrichtigungsart: ${kind}` };
  if (NOTIFICATION_KINDS[kind].severity === "critical" && (!channels.inApp || !channels.email)) {
    return { ok: false, error: NTF02_MESSAGE };
  }
  return { ok: true };
}

/** NTF-001: dedupeKey = kind + entity + day (Berlin calendar date of the event). */
export function dedupeKeyFor(kind: string, entity: { table: string; id: string } | undefined, day: string): string {
  return [kind, entity ? `${entity.table}:${entity.id}` : "-", day].join("|");
}

/** NTF-006: an unresolved `error` older than 24 h is re-sent once. */
export const ESCALATION_AFTER_MS = 24 * 60 * 60 * 1000;
export function escalationDue(
  n: { severity: NotificationSeverity; createdAt: number; resolvedAt?: number; escalatedAt?: number },
  now: number,
): boolean {
  return (
    n.severity === "error" &&
    n.resolvedAt === undefined &&
    n.escalatedAt === undefined &&
    now - n.createdAt >= ESCALATION_AFTER_MS
  );
}

/** NTF-001: read notifications are kept 90 days (not GoBD-relevant, retention class `none`). */
export const READ_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export function purgeDue(n: { readAt?: number }, now: number): boolean {
  return n.readAt !== undefined && now - n.readAt >= READ_RETENTION_MS;
}

/** NTF-004 priority mapping (critical = 5, error = 4, warning = 3); info uses ntfy's default 3. */
export function ntfyPriority(severity: NotificationSeverity): 1 | 2 | 3 | 4 | 5 {
  return severity === "critical" ? 5 : severity === "error" ? 4 : 3;
}

export interface OutgoingNotification {
  readonly kind: string;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body?: string | undefined;
  readonly link?: string | undefined;
}

/** The text that leaves the instance: minimal by default, full title/body only with „Details senden". */
function outgoingText(n: OutgoingNotification, sendDetails: boolean): { title: string; body: string | undefined } {
  if (sendDetails) return { title: n.title, body: n.body };
  return { title: kindDef(n.kind)?.minimal ?? "Neue Benachrichtigung – Details in der App", body: undefined };
}

const appLink = (appUrl: string | undefined, link: string | undefined): string | undefined =>
  appUrl ? `${appUrl.replace(/\/$/, "")}${link ?? "/benachrichtigungen"}` : undefined;

/** NTF-004: ntfy publish payload (JSON publishing). */
export function ntfyMessage(
  n: OutgoingNotification,
  opts: { topic: string; sendDetails: boolean; appUrl?: string | undefined },
): { topic: string; title: string; message: string; priority: number; click?: string } {
  const text = outgoingText(n, opts.sendDetails);
  const click = appLink(opts.appUrl, n.link);
  return {
    topic: opts.topic,
    title: text.title,
    message: text.body ?? text.title,
    priority: ntfyPriority(n.severity),
    ...(click ? { click } : {}),
  };
}

/** NTF-003: plain subject „[{Firma}] {Titel}" and a data-minimal body with the link into the app. */
export function notificationMail(
  n: OutgoingNotification,
  opts: { companyName: string; sendDetails: boolean; appUrl?: string | undefined },
): { subject: string; text: string; html: string } {
  const text = outgoingText(n, opts.sendDetails);
  const link = appLink(opts.appUrl, n.link);
  const lines = [
    text.title,
    ...(text.body ? ["", text.body] : []),
    "",
    ...(link ? [`Öffnen: ${link}`, "(Der Link funktioniert nur mit Anmeldung.)"] : []),
  ];
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    subject: `[${opts.companyName}] ${text.title}`,
    text: lines.join("\n"),
    html: lines.map((l) => (l ? `<p>${esc(l)}</p>` : "")).join(""),
  };
}

/** E-NTF-01: a warning after 3 consecutive ntfy failures. */
export const NTFY_FAILURES_BEFORE_WARNING = 3;
