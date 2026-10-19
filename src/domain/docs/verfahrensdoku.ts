/**
 * Verfahrensdokumentation generator v1 (F12 AUD-024/AUD-025, §4.6; GOBD-10, SEC-07, DSGVO-01, GOBD-08). Pure:
 * `buildVerfahrensdoku(sources, inputs)` renders the 16 chapters and the annex from the recorded settings
 * (auto-filled, live) plus the owner's structured inputs; every chapter carries a status „automatisch“,
 * „vollständig“ or „Angaben fehlen“. `releaseIssue` is E-AUD-40; `watchSnapshot`/`watchDiff` implement the AUD-025
 * watch list (E-AUD-41). P1 stores the released version as Markdown with SHA-256 (PDF/A rendering follows in P3).
 */
import type { MemberRole } from "../schemas/actor";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";

export type ChapterStatus = "automatisch" | "vollständig" | "Angaben fehlen";

export interface OwnerField {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  /** Pre-filled suggestion (e.g. the scan work instruction template). */
  readonly template?: string;
}

export interface ChapterDef {
  readonly n: number | "Anhang";
  readonly title: string;
  readonly fields: readonly OwnerField[];
}

const f = (key: string, label: string, required = true, template?: string): OwnerField =>
  template === undefined ? { key, label, required } : { key, label, required, template };

const SCAN_TEMPLATE =
  "Papierbelege werden am Tag des Eingangs, spätestens nach 10 Tagen, von [Name] mit [Gerät/App] farbig und vollständig gescannt. Vor dem Hochladen wird die Lesbarkeit geprüft; nach dem Hochladen prüft [Name] die Übereinstimmung mit dem Original. Papieroriginale werden [vernichtet nach … / aufbewahrt bis …].";

export const VD_CHAPTERS: readonly ChapterDef[] = [
  {
    n: 1,
    title: "Allgemeine Beschreibung",
    fields: [
      f("business", "Beschreibung der Tätigkeit"),
      f("responsible", "Verantwortliche Person(en) für Buchführung und Belege"),
      f("taxAdvisor", "Steuerberater (falls beauftragt)", false),
      f("deputy", "Vertretung bei Abwesenheit", false),
    ],
  },
  { n: 2, title: "Eingesetzte Hard- und Software", fields: [f("devices", "Vom Inhaber genutzte Geräte")] },
  {
    n: 3,
    title: "Zugriffskonzept",
    fields: [
      f("physicalAccess", "Physischer Zugang zu den Geräten"),
      f("secretsCustody", "Wer kennt Zugangsdaten und Schlüssel, wo werden sie verwahrt"),
    ],
  },
  {
    n: 4,
    title: "Belegeingang und ersetzendes Scannen",
    fields: [f("scanProcedure", "Scan-Verfahren (wer, wann, Qualitätskontrolle, Vernichtung)", true, SCAN_TEMPLATE)],
  },
  { n: 5, title: "Ausgangsrechnungen", fields: [f("invoiceAgreements", "Besondere Vereinbarungen", false)] },
  { n: 6, title: "Zahlungsverkehr und Bankdaten", fields: [f("manualPayments", "Manuelle Zahlungsabwicklung")] },
  { n: 7, title: "Kasse", fields: [f("cashHandling", "Umgang mit Bargeld und Zählweise")] },
  { n: 8, title: "Buchführung", fields: [f("closingRoutine", "Monatlicher Abschlussablauf")] },
  { n: 9, title: "Anlagenbuchhaltung", fields: [f("inventory", "Inventurverfahren")] },
  { n: 10, title: "Steuern", fields: [f("taxSubmitter", "Wer reicht Steuererklärungen und Voranmeldungen ein")] },
  {
    n: 11,
    title: "Schnittstellen und Datenmigration",
    fields: [f("oldSystemData", "Wo die Daten des Altsystems liegen und wie lange")],
  },
  { n: 12, title: "Archivierung und Aufbewahrung", fields: [] },
  {
    n: 13,
    title: "Datensicherung und Wiederherstellung",
    fields: [f("restoreResponsibility", "Verantwortlich für die Wiederherstellung")],
  },
  { n: 14, title: "Internes Kontrollsystem", fields: [f("reviewRoutine", "Prüfroutine (wer, wie oft)")] },
  { n: 15, title: "Datenschutz", fields: [f("dpoContact", "Datenschutzbeauftragter (falls benannt)", false)] },
  { n: 16, title: "Änderungshistorie", fields: [] },
  {
    n: "Anhang",
    title: "Anhang: Buchungsregeln, Verzeichnis nach Art. 30 DSGVO, Scan-Arbeitsanweisung",
    fields: [f("signOff", "Freigabe durch (Name, Funktion)")],
  },
];

export interface VdSources {
  today: string;
  company: {
    name: string;
    legalForm: string;
    address: string;
    taxationMethod: string | null;
    chart: string | null;
    kleinunternehmer: boolean;
    profitMethod: string | null;
  };
  software: { appVersion: string; hosting: string; edge: string };
  access: {
    members: readonly { role: MemberRole; expiresAt: number | null; totp: boolean }[];
    apiKeys: readonly { name: string; scopes: readonly string[]; kind: "api" | "mcp" }[];
    tailnet: string | null;
  };
  numberRanges: readonly { name: string; format: string; active: boolean }[];
  layoutsCount: number;
  bankAccounts: readonly { name: string; kind: string; ledgerAccount: string }[];
  hasCashTransfers: boolean;
  integrations: readonly string[];
  rules: { posting: string; roleMapping: string | null; retention: string };
  integrity: { checkpointKid: string | null; lastCheckpoint: string | null; backupConfigured: boolean };
  restoreDrills: readonly { date: string; kind: string; integrityOk: boolean }[];
  services: readonly { name: string; role: string; region: string; avvConfirmedAt: number | null }[];
  imports: readonly { source: string; at: number; files: readonly { name: string; sha256: string }[] }[];
  changes: readonly { at: number; action: string; label: string }[];
}

export interface RenderedChapter {
  n: number | "Anhang";
  title: string;
  status: ChapterStatus;
  auto: string[];
  fields: (OwnerField & { value: string })[];
  missing: string[];
}

const ROLE_DE: Record<MemberRole, string> = {
  owner: "Inhaber",
  bookkeeper: "Buchhaltung",
  viewer: "Lesezugriff",
  auditor: "Prüfer",
};
const day = (ms: number) =>
  new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Berlin",
  }).format(ms);
const list = (items: readonly string[], empty: string) => (items.length ? items.join("; ") : empty);

function autoText(n: ChapterDef["n"], s: VdSources): string[] {
  const c = s.company;
  switch (n) {
    case 1:
      return [
        `Unternehmen: ${c.name} (${c.legalForm}), ${c.address}.`,
        `Besteuerung: ${c.kleinunternehmer ? "Kleinunternehmer nach § 19 UStG" : "Regelbesteuerung"}; Versteuerung ${c.taxationMethod === "ist" ? "nach vereinnahmten Entgelten (Ist)" : "nach vereinbarten Entgelten (Soll)"}; Gewinnermittlung ${c.profitMethod === "bilanz" ? "Bilanz" : "Einnahmenüberschussrechnung"}; Kontenrahmen ${c.chart ?? "nicht festgelegt"}.`,
      ];
    case 2:
      return [
        `Software: selbst betriebene Rechnungs- und Buchhaltungsanwendung, Version ${s.software.appVersion} (Next.js, Convex, E-Rechnung-Validator KoSIT/Mustang).`,
        `Betrieb: ${s.software.hosting}. Zugang: ${s.software.edge}.`,
      ];
    case 3: {
      const roles = new Map<string, number>();
      for (const m of s.access.members) roles.set(ROLE_DE[m.role], (roles.get(ROLE_DE[m.role]) ?? 0) + 1);
      return [
        "Anmeldung nur mit Passkey oder E-Mail-Code, keine Passwörter; Rollen Inhaber, Buchhaltung, Lesezugriff und Prüfer mit Berechtigungsprüfung bei jedem Zugriff.",
        `Mitglieder: ${list(
          [...roles].map(([r, k]) => `${k} × ${r}`),
          "keine",
        )}; befristete Zugänge: ${s.access.members.filter((m) => m.expiresAt !== null).length}; mit zweitem Faktor: ${s.access.members.filter((m) => m.totp).length}.`,
        `API- und MCP-Schlüssel: ${list(
          s.access.apiKeys.map((k) => `${k.name} (${k.kind === "mcp" ? "MCP" : "API"}: ${k.scopes.join(", ")})`),
          "keine",
        )}.`,
        s.access.tailnet ? `Netz: nur über das Tailnet ${s.access.tailnet}.` : "Netz: nur über das private Tailnet.",
      ];
    }
    case 4:
      return [
        `Belegeingang: Upload mit SHA-256-Prüfsumme bei Erfassung; E-Rechnungen werden validiert. Aktive Integrationen: ${list(s.integrations, "keine")}.`,
      ];
    case 5:
      return [
        `Nummernkreise: ${list(
          s.numberRanges.filter((r) => r.active).map((r) => `${r.name} (${r.format})`),
          "keine",
        )}. Nummern werden lückenlos beim Fertigstellen vergeben; fertiggestellte Rechnungen sind unveränderbar, Korrekturen nur per Storno oder Rechnungskorrektur.`,
        `Layouts: ${s.layoutsCount} (versioniert, die verwendete Version wird im Beleg gespeichert). Versand: Download und Versandprotokoll; die Anwendung versendet keine E-Mails an Kunden.`,
      ];
    case 6:
      return [
        `Konten: ${list(
          s.bankAccounts.map((b) => `${b.name} (${b.kind}, Finanzkonto ${b.ledgerAccount})`),
          "keine",
        )}. Kontoauszüge werden als CAMT.053/MT940/CSV importiert (Kontinuitätsprüfung, monatliches PDF); der Abruf über Enable Banking (PSD2) folgt.`,
      ];
    case 7:
      return [
        s.hasCashTransfers
          ? "Bargeld nur zu Rechnungen und Belegen; Kassenbestand nie negativ; Geldtransit mit Eigenbeleg; kein elektronisches Kassensystem."
          : "Es werden keine Bargeschäfte geführt; kein elektronisches Kassensystem.",
      ];
    case 8:
      return [
        `Buchungsregeln ${s.rules.posting}, Kontenzuordnung ${s.rules.roleMapping ?? "—"}. Das Journal ist unveränderbar; Korrekturen erfolgen per Gegenbuchung, Zeiträume werden festgeschrieben.`,
      ];
    case 9:
      return ["Anlagenbuchhaltung mit AfA-Regeln je Jahr (ab P3)."];
    case 10:
      return [
        "Umsatzsteuer-Voranmeldung und ZM werden aus den Buchungen vorbereitet und manuell übermittelt; nach Übermittlung wird der Zeitraum festgeschrieben.",
      ];
    case 11:
      return [
        "Schnittstellen: REST-API und MCP mit eigenen Schlüsseln und Berechtigungen; jede Änderung wird protokolliert.",
        s.imports.length
          ? `Datenmigration: ${s.imports
              .map(
                (i) =>
                  `${i.source} am ${day(i.at)} (${i.files.map((x) => `${x.name} SHA-256 ${x.sha256.slice(0, 16)}…`).join(", ")})`,
              )
              .join("; ")}. Übernommene Belege sind schreibgeschützte Archivdatensätze mit Original-PDF.`
          : "Datenmigration: keine.",
      ];
    case 12:
      return [
        `Formate PDF/A-3 und XML (EN 16931), Prüfsummen SHA-256, Aufbewahrungsklassen nach Regeltabelle ${s.rules.retention}; vor Fristablauf wird nichts gelöscht.`,
      ];
    case 13:
      return [
        s.integrity.backupConfigured
          ? "Tägliche Sicherungen nach Cloudflare R2 (Postgres, Convex-Export, Convex-Volume); Status unter Einstellungen › System › Datensicherungen."
          : "Sicherungsstatus nicht eingerichtet (R2-Lesezugang fehlt).",
        `Wiederherstellungsproben: ${list(
          s.restoreDrills.map(
            (d) => `${formatGermanDate(d.date as CalendarDate)} ${d.integrityOk ? "erfolgreich" : "mit Befund"}`,
          ),
          "noch keine",
        )}.`,
      ];
    case 14:
      return [
        "Hash-Kette über alle Protokolleinträge, tägliche Prüfung und Startprüfung alle 6 Stunden, täglich signierter Prüfpunkt außerhalb des Servers, Invariantenprüfung, Benachrichtigungen bei Befunden.",
        s.integrity.checkpointKid
          ? `Fingerabdruck des Prüfpunkt-Schlüssels (kid): ${s.integrity.checkpointKid}; letzter Prüfpunkt ${s.integrity.lastCheckpoint ?? "—"}.`
          : "Noch kein signierter Prüfpunkt.",
      ];
    case 15:
      return [
        `Externe Dienste: ${list(
          s.services.map(
            (x) =>
              `${x.name} (${x.role}, ${x.region}${x.avvConfirmedAt ? `, AVV bestätigt ${day(x.avvConfirmedAt)}` : ""})`,
          ),
          "keine",
        )}. Verzeichnis nach Art. 30 DSGVO im Anhang.`,
      ];
    case 16:
      return [
        s.changes.length
          ? `Änderungen an Einstellungen (Auszug): ${s.changes
              .slice(0, 20)
              .map((x) => `${day(x.at)} ${x.label || x.action}`)
              .join("; ")}.`
          : "Noch keine protokollierten Einstellungsänderungen.",
      ];
    default:
      return [
        `Buchungsregeln ${s.rules.posting}; Verzeichnis nach Art. 30 DSGVO und Scan-Arbeitsanweisung siehe Kapitel 15 und 4.`,
      ];
  }
}

export function buildVerfahrensdoku(s: VdSources, inputs: Readonly<Record<string, string>>) {
  const chapters: RenderedChapter[] = VD_CHAPTERS.map((c) => {
    const fields = c.fields.map((x) => ({ ...x, value: (inputs[x.key] ?? "").trim() }));
    const missing = fields.filter((x) => x.required && x.value === "").map((x) => x.label);
    const status: ChapterStatus =
      c.fields.length === 0 ? "automatisch" : missing.length ? "Angaben fehlen" : "vollständig";
    return { n: c.n, title: c.title, status, auto: autoText(c.n, s), fields, missing };
  });
  return {
    stand: formatGermanDate(s.today as CalendarDate),
    chapters,
    complete: chapters.every((c) => c.missing.length === 0),
  };
}

export type Verfahrensdoku = ReturnType<typeof buildVerfahrensdoku>;

/** E-AUD-40: release only with every mandatory owner input. */
export function releaseIssue(doc: Verfahrensdoku): string | null {
  const c = doc.chapters.find((x) => x.missing.length > 0);
  return c ? `Für die Freigabe fehlen Angaben in Kapitel ${c.n}: ${c.missing[0]}.` : null;
}

export function verfahrensdokuMarkdown(
  doc: Verfahrensdoku,
  meta: { company: string; version: number; validFrom: string },
): string {
  const out = [
    `# Verfahrensdokumentation – ${meta.company}`,
    "",
    `Version ${meta.version}, gültig ab ${formatGermanDate(meta.validFrom as CalendarDate)} (Stand ${doc.stand})`,
    "",
  ];
  for (const c of doc.chapters) {
    out.push(`## ${c.n === "Anhang" ? "" : `${c.n}. `}${c.title}`, "");
    for (const p of c.auto) out.push(p, "");
    for (const x of c.fields) if (x.value) out.push(`**${x.label}:** ${x.value}`, "");
  }
  return out.join("\n");
}

// ── AUD-025 watch list ────────────────────────────────────────────────────────────────────────────────

export const WATCH_LABELS: Readonly<Record<string, string>> = {
  legalForm: "Rechtsform",
  taxationMethod: "Versteuerungsart",
  kleinunternehmer: "Kleinunternehmerregelung",
  profitMethod: "Gewinnermittlung",
  chart: "Kontenrahmen",
  access: "Zugriffskonzept und Rollen",
  apiKeys: "API- und MCP-Schlüssel",
  backup: "Datensicherung",
  integrations: "Integrationen / OCR",
  numberRanges: "Nummernkreise",
  retention: "Aufbewahrungsregeln",
  software: "Software-Version",
  posting: "Buchungsregeln",
  roleMapping: "Kontenzuordnung",
};

export function watchSnapshot(s: VdSources): Record<string, string> {
  const minor = s.software.appVersion.split(".").slice(0, 2).join(".");
  return {
    legalForm: s.company.legalForm,
    taxationMethod: s.company.taxationMethod ?? "",
    kleinunternehmer: String(s.company.kleinunternehmer),
    profitMethod: s.company.profitMethod ?? "",
    chart: s.company.chart ?? "",
    access: [...s.access.members.map((m) => m.role)].sort().join(","),
    apiKeys: s.access.apiKeys
      .map((k) => `${k.kind}:${k.name}:${[...k.scopes].sort().join("+")}`)
      .sort()
      .join(","),
    backup: String(s.integrity.backupConfigured),
    integrations: [...s.integrations].sort().join(","),
    numberRanges: s.numberRanges
      .filter((r) => r.active)
      .map((r) => r.format)
      .sort()
      .join(","),
    retention: s.rules.retention,
    software: minor,
    posting: s.rules.posting,
    roleMapping: s.rules.roleMapping ?? "",
  };
}

/** E-AUD-41: changed watch items since the release (empty = up to date). */
export function watchDiff(
  released: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): { key: string; label: string; before: string; after: string }[] {
  return Object.keys(WATCH_LABELS)
    .filter((k) => (released[k] ?? "") !== (current[k] ?? ""))
    .map((k) => ({ key: k, label: WATCH_LABELS[k] ?? k, before: released[k] ?? "", after: current[k] ?? "" }));
}

export const outdatedMessage = (diff: readonly { label: string }[]): string =>
  `Verfahrensdokumentation muss aktualisiert werden: ${diff.map((d) => d.label).join(", ")}.`;
