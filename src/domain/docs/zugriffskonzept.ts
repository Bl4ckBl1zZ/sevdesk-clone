/**
 * Verfahrensdokumentation chapter „Zugriffskonzept“ (F01 SET-047, F12 §5 chapter 3; SEC-01, SEC-07, GOBD-10).
 * Generated from the recorded access concept (SET-007), the members with roles and validity, and the API/MCP keys.
 * The owner adds what the software cannot know (device custody, who knows secrets) in the free-text part.
 */
import type { MemberRole } from "../schemas/actor";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";

export interface ZugriffskonzeptInput {
  today: string;
  accessConcept?:
    | { baseDomain: string; network: "tailnet"; tailnetName?: string | undefined; confirmedAt: number }
    | undefined;
  members: readonly { email: string; role: MemberRole; expiresAt: number | null; totp: boolean }[];
  apiKeys: readonly { name: string; scopes: readonly string[]; kind: "api" | "mcp" }[];
}

export interface DocSection {
  heading: string;
  paragraphs: string[];
  table?: { head: string[]; rows: string[][] };
}

export interface DocChapter {
  title: string;
  stand: string;
  sections: DocSection[];
}

const ROLE_DE: Record<MemberRole, string> = {
  owner: "Inhaber",
  bookkeeper: "Buchhaltung",
  viewer: "Lesezugriff",
  auditor: "Prüfer",
};

const berlinDate = (ms: number) =>
  new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Berlin",
  }).format(ms);

export function zugriffskonzept(i: ZugriffskonzeptInput): DocChapter {
  const ac = i.accessConcept;
  const hosts = ac ? ["app", "api", "convex-dash"].map((h) => `${h}.${ac.baseDomain}`) : [];
  return {
    title: "Zugriffskonzept",
    stand: formatGermanDate(i.today as CalendarDate),
    sections: [
      {
        heading: "Anmeldung",
        paragraphs: [
          "Mitglieder melden sich mit einem Passkey (WebAuthn) oder einem einmaligen E-Mail-Code an; ein Passwort gibt es nicht. Optional ist ein zweiter Faktor (TOTP) eingerichtet.",
          "Sensible Aktionen (Mitglieder, Einladungen, API-Schlüssel) verlangen eine Bestätigung, wenn die Anmeldung älter als 10 Minuten ist. Sitzungen können je Mitglied abgemeldet werden.",
        ],
      },
      {
        heading: "Netzwerkzugang",
        paragraphs: ac
          ? [
              `Die Anwendung ist ausschließlich im Tailnet${ac.tailnetName ? ` „${ac.tailnetName}“` : ""} erreichbar, nicht aus dem öffentlichen Internet. Hosts: ${hosts.join(", ")}.`,
              `Die Oberfläche läuft unter app.${ac.baseDomain}; api.${ac.baseDomain} liefert nur die REST-/MCP-Schnittstellen. Das Datenbank-Dashboard ist zusätzlich mit Basic Auth geschützt. Erfasst am ${berlinDate(ac.confirmedAt)}.`,
            ]
          : ["Das Zugriffskonzept wurde in der Einrichtung noch nicht erfasst."],
      },
      {
        heading: "Mitglieder und Rollen",
        paragraphs: [
          "Rollen: Inhaber (alle Rechte), Buchhaltung (Belege und Dokumente, keine Einstellungen), Lesezugriff, Prüfer (nur lesend, befristet auf höchstens 30 Tage, auf Wirtschaftsjahre beschränkt). Jede Änderung wird im Protokoll festgehalten.",
        ],
        table: {
          head: ["E-Mail", "Rolle", "Gültigkeit", "TOTP"],
          rows: i.members.map((m) => [
            m.email,
            ROLE_DE[m.role],
            m.expiresAt === null ? "unbefristet" : `bis ${berlinDate(m.expiresAt)}`,
            m.totp ? "ja" : "nein",
          ]),
        },
      },
      {
        heading: "API- und MCP-Schlüssel",
        paragraphs:
          i.apiKeys.length === 0
            ? ["Keine Schlüssel angelegt."]
            : i.apiKeys.map(
                (k) =>
                  `${k.name} (${k.kind === "api" ? "API" : "MCP"}) — ${k.scopes.join(", ") || "keine Berechtigungen"}`,
              ),
      },
      {
        heading: "Prüferzugang (Datenzugriff der Finanzverwaltung)",
        paragraphs: [
          "Für eine Außenprüfung lädt der Inhaber die Prüferin bzw. den Prüfer mit der Rolle „Prüfer“ ein: befristet, nur lesend, beschränkt auf die betroffenen Wirtschaftsjahre und mit Angabe des Prüfungsanlasses. Verlängerungen erfordern eine Begründung; nach Ablauf werden alle Sitzungen beendet.",
        ],
      },
      {
        heading: "Kontrollen",
        paragraphs: [
          "Die Sicherheitsprüfungen unter /einstellungen/system/sicherheit zeigen Sitzungen abgelaufener Mitglieder, gesetzte Geheimnisse, Zertifikate, Erreichbarkeit nur im Tailnet, Integritätsprüfung, Prüfpunkte und Datensicherungen.",
        ],
      },
    ],
  };
}

export function zugriffskonzeptMarkdown(doc: DocChapter): string {
  const lines = [`# ${doc.title}`, "", `Stand: ${doc.stand}`, ""];
  for (const s of doc.sections) {
    lines.push(`## ${s.heading}`, "");
    for (const p of s.paragraphs) lines.push(p, "");
    if (s.table) {
      lines.push(`| ${s.table.head.join(" | ")} |`, `|${s.table.head.map(() => "---").join("|")}|`);
      for (const r of s.table.rows) lines.push(`| ${r.join(" | ")} |`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
