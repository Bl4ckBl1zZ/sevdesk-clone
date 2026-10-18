/**
 * Human-readable German lines for the dashboard „Verlauf“ (04 §4.7, DASH-009). Pure. Only business acts are
 * described; technical entries (artifact pipeline, sign-ins, integrity runs, auditor access, journal postings that
 * accompany an act, notifications) return null and are skipped. The full log stays in Einstellungen › Audit-Log.
 * The view never exposes `diff`, IPs or e-mail addresses: the actor is shown by role or channel.
 */
import { ROLE_LABEL_DE } from "../access/permissions";
import type { MemberRole } from "../schemas/actor";

export interface AuditEntryLike {
  action: string;
  entity: { table: string; id: string; label?: string | undefined };
}

type Template = (label: string) => string;

/** `{label}` is the entity label (document number, contact name …); templates without it ignore it. */
const TEMPLATES: Readonly<Record<string, Template>> = {
  "document.create_draft": () => "Entwurf angelegt",
  "document.update_draft": () => "Entwurf bearbeitet",
  "document.delete_draft": () => "Entwurf gelöscht",
  "document.finalize": (l) => `${l} fertiggestellt`,
  "document.mark_sent": (l) => `${l} als versendet markiert`,
  "document.mark_sent_retracted": (l) => `Versandmarkierung von ${l} zurückgenommen`,
  "document.export": (l) => `${l} exportiert`,
  "document.cancel": (l) => `${l} storniert`,
  "document.create_correction": (l) => `Rechnungskorrektur zu ${l} erstellt`,
  "document.convert": (l) => `${l} umgewandelt`,
  "document.accept": (l) => `${l} angenommen`,
  "document.reject": (l) => `${l} abgelehnt`,
  "document.import": (l) => `${l} importiert`,
  "payment.record": (l) => `Zahlung zu ${l} erfasst`,
  "payment.reverse": (l) => `Zahlung zu ${l} storniert`,
  "payment.refund": (l) => `Erstattung zu ${l} erfasst`,
  "bank.match": (l) => `Zahlung ${l} zugeordnet`,
  "bank.unmatch": (l) => `Zuordnung ${l} aufgehoben`,
  "bank.mark": (l) => `Umsatz ${l} markiert`,
  "bank.unmark": (l) => `Markierung ${l} aufgehoben`,
  "bank.rollback": () => "Kontoauszug-Import zurückgenommen",
  "bank.statement_pdf": () => "Kontoauszug-PDF abgelegt",
  "cash.transfer": () => "Bargeldbewegung erfasst",
  "cash.transfer_reverse": () => "Bargeldbewegung storniert",
  "contact.create": (l) => `Kontakt ${l} angelegt`,
  "contact.update": (l) => `Kontakt ${l} geändert`,
  "contact.merge": (l) => `Kontakte zusammengeführt (${l})`,
  "product.create": (l) => `Produkt ${l} angelegt`,
  "product.update": (l) => `Produkt ${l} geändert`,
  "dunning.reminder.finalize": (l) => `Mahnung ${l} fertiggestellt`,
  "dunning.run": () => "Mahnlauf ausgeführt",
  "recurring.generate": () => "Wiederkehrende Rechnungen erzeugt",
  "period.lock": (l) => `Zeitraum ${l} festgeschrieben`,
  "import.commit": () => "sevdesk-Import übernommen",
  "member.create": () => "Mitglied hinzugefügt",
  "member.role_change": () => "Rolle eines Mitglieds geändert",
  "invite.create": () => "Einladung erstellt",
  "api_key.create": () => "API-Schlüssel erstellt",
  "api_key.revoke": () => "API-Schlüssel widerrufen",
  "settings.setup.complete": () => "Einrichtung abgeschlossen",
};

const DRAFT_LABEL = /^Entwurf\b/;
/** Used when the entry has no label, so „{label} fertiggestellt“ still reads as a sentence. */
const FALLBACK_NOUN: Readonly<Record<string, string>> = { salesDocuments: "Dokument" };

/** Groups described by one line regardless of the sub-action (settings.<section>.update). */
const GROUP_TEMPLATES: Readonly<Record<string, Template>> = {
  settings: () => "Einstellungen geändert",
};

export function describeAuditEntry(entry: AuditEntryLike): string | null {
  const raw = entry.entity.label?.trim() ?? "";
  const label = DRAFT_LABEL.test(raw) ? "" : raw;
  const template = TEMPLATES[entry.action];
  if (template) {
    return template(label || (FALLBACK_NOUN[entry.entity.table] ?? ""))
      .replace(/\s+/g, " ")
      .trim();
  }
  const dot = entry.action.indexOf(".");
  if (dot <= 0) return null;
  const group = GROUP_TEMPLATES[entry.action.slice(0, dot)];
  return group ? group(label) : null;
}

/** Who did it, without personal data: the member's role label, „API“, „KI-Assistent (MCP)“ or „System“. */
export function actorDisplay(actor: string, role?: string | undefined): string {
  const kind = actor.slice(0, actor.indexOf(":"));
  if (kind === "user") return role && role in ROLE_LABEL_DE ? ROLE_LABEL_DE[role as MemberRole] : "Benutzer";
  if (kind === "api-key") return "API";
  if (kind === "mcp") return "KI-Assistent (MCP)";
  return "System";
}

export interface ActivityLine {
  at: number;
  text: string;
  by: string;
}

export const RECENT_ACTIVITY_LIMIT = 5;

/**
 * The latest `limit` described entries, newest first (input newest first). The same act on the same entity is
 * shown once (a payment writes its row and then patches the journal ids under the same action).
 */
export function recentActivity(
  rows: readonly (AuditEntryLike & { at: number; actor: string; actorRole?: string | undefined })[],
  limit = RECENT_ACTIVITY_LIMIT,
): ActivityLine[] {
  const seen = new Set<string>();
  const out: ActivityLine[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const text = describeAuditEntry(r);
    if (!text) continue;
    const key = `${r.action}|${r.entity.table}|${r.entity.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ at: r.at, text, by: actorDisplay(r.actor, r.actorRole) });
  }
  return out;
}
