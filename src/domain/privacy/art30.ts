/**
 * Verzeichnis von Verarbeitungstätigkeiten (Art. 30 Abs. 1 DSGVO) — template generated from the settings
 * (01 DSGVO-01, F12 PRV-015). Annex of the Verfahrensdokumentation and the source of the Art. 15 information (P3).
 * Pure. The owner reviews and signs it; the software fills what it knows (controller, activities of this app,
 * recipients from the external-services list, retention from the rule table, technical measures).
 *
 * LEGAL-OPEN: 01 DSGVO-01 — the legal bases are the usual ones for an invoicing/bookkeeping tool of a sole trader
 * (Art. 6 Abs. 1 lit. b, c, f DSGVO); the owner confirms them for the actual business.
 */
import { RETENTION_CLASS_LABEL_DE } from "../rules/retention";
import type { ConfiguredService } from "./external-services";
import { REGION_LABEL_DE, ROLE_LABEL_DE } from "./external-services";

export interface Art30Input {
  readonly controller: {
    name: string;
    address: string;
    email?: string | undefined;
    representative?: string | undefined;
  };
  readonly dpo?: string | undefined;
  readonly services: readonly ConfiguredService[];
  readonly today: string;
}

export interface ProcessingActivity {
  readonly name: string;
  readonly purpose: string;
  readonly legalBasis: string;
  readonly subjects: string;
  readonly data: string;
  readonly recipients: string;
  readonly thirdCountry: string;
  readonly retention: string;
}

export interface Art30Record {
  readonly title: string;
  readonly stand: string;
  readonly controller: Art30Input["controller"];
  readonly dpo: string;
  readonly activities: readonly ProcessingActivity[];
  readonly toms: readonly string[];
}

const recipientsOf = (services: readonly ConfiguredService[], ids: readonly string[]) => {
  const list = services.filter((s) => ids.includes(s.id));
  if (list.length === 0) return "Keine externen Empfänger";
  return list.map((s) => `${s.name} (${ROLE_LABEL_DE[s.role]}, ${REGION_LABEL_DE[s.effectiveRegion]})`).join("; ");
};

const transfersOf = (services: readonly ConfiguredService[], ids: readonly string[]) => {
  const non = services.filter(
    (s) =>
      ids.includes(s.id) && s.role !== "public_authority" && !["EU", "DE", "self_hosted"].includes(s.effectiveRegion),
  );
  if (non.length === 0) return "Keine";
  return non
    .map(
      (s) =>
        `${s.name}: ${s.avvConfirmedAt ? "AVV bestätigt" : "AVV fehlt"} (Rechtsgrundlage der Übermittlung beim Anbieter prüfen)`,
    )
    .join("; ");
};

export function art30Record(i: Art30Input): Art30Record {
  const s = i.services;
  const activities: ProcessingActivity[] = [
    {
      name: "Rechnungsstellung und Angebote",
      purpose: "Erstellung, Archivierung und Versandprotokoll von Angeboten, Rechnungen und Mahnungen",
      legalBasis: "Art. 6 Abs. 1 lit. b DSGVO (Vertrag), lit. c (§ 14 UStG, § 147 AO)",
      subjects: "Kunden und Ansprechpartner",
      data: "Name, Anschrift, USt-IdNr., E-Mail, Telefon, Leistungen, Beträge, Zahlungsbedingungen",
      recipients: recipientsOf(s, ["cloudflare_r2", "cloudflare_edge"]),
      thirdCountry: transfersOf(s, ["cloudflare_r2", "cloudflare_edge"]),
      retention: `${RETENTION_CLASS_LABEL_DE.vouchers8}; Angebote und Briefe: ${RETENTION_CLASS_LABEL_DE.letters6}`,
    },
    {
      name: "Buchführung und Steuern",
      purpose: "Ordnungsmäßige Buchführung, Umsatzsteuer-Voranmeldungen, Einnahmenüberschussrechnung",
      legalBasis: "Art. 6 Abs. 1 lit. c DSGVO (§§ 140 ff. AO, § 22 UStG)",
      subjects: "Kunden, Lieferanten",
      data: "Buchungen mit Belegbezug, Kontakt- und Zahlungsdaten",
      recipients: `Finanzamt (Behörde); ${recipientsOf(s, ["cloudflare_r2"])}`,
      thirdCountry: transfersOf(s, ["cloudflare_r2"]),
      retention: RETENTION_CLASS_LABEL_DE.books10,
    },
    {
      name: "Zahlungsabgleich und Bankdaten",
      purpose: "Zuordnung von Zahlungseingängen zu Rechnungen",
      legalBasis: "Art. 6 Abs. 1 lit. b und c DSGVO",
      subjects: "Kunden, Zahlungspflichtige, Gegenparteien",
      data: "IBAN, Name, Verwendungszweck, Beträge",
      recipients: recipientsOf(s, ["enable_banking", "cloudflare_r2"]),
      thirdCountry: transfersOf(s, ["enable_banking", "cloudflare_r2"]),
      retention: RETENTION_CLASS_LABEL_DE.vouchers8,
    },
    {
      name: "USt-IdNr.-Prüfung",
      purpose: "Nachweis der Prüfung ausländischer USt-IdNrn. bei innergemeinschaftlichen Umsätzen",
      legalBasis: "Art. 6 Abs. 1 lit. c DSGVO (§ 18e UStG, § 6a UStG)",
      subjects: "Unternehmerische Kunden in der EU",
      data: "USt-IdNr., Name, Anschrift, Prüfergebnis",
      recipients: recipientsOf(s, ["evatr", "vies"]),
      thirdCountry: "Keine",
      retention: RETENTION_CLASS_LABEL_DE.books10,
    },
    {
      name: "Benutzerkonten, Anmeldung und Protokoll",
      purpose: "Zugriffsschutz, Nachvollziehbarkeit von Änderungen (GoBD)",
      legalBasis: "Art. 6 Abs. 1 lit. c DSGVO (GoBD Rz. 107 ff.) und lit. f (IT-Sicherheit)",
      subjects: "Mitglieder (Inhaber, Buchhaltung, Prüfer)",
      data: "E-Mail-Adresse, Passkey-Metadaten, Sitzungen, Protokolleinträge",
      recipients: recipientsOf(s, ["cloudflare_email", "tailscale", "cloudflare_edge"]),
      thirdCountry: transfersOf(s, ["cloudflare_email", "tailscale", "cloudflare_edge"]),
      retention: `Protokoll: ${RETENTION_CLASS_LABEL_DE.books10}; Sitzungen bis zum Ablauf`,
    },
    {
      name: "Benachrichtigungen",
      purpose: "Hinweise zu Fristen, Zahlungen und Systemzustand an den Inhaber",
      legalBasis: "Art. 6 Abs. 1 lit. f DSGVO",
      subjects: "Inhaber; in Hinweisen ggf. Kunden (nur mit „Details senden“)",
      data: "Kurze Hinweistexte",
      recipients: recipientsOf(s, ["cloudflare_email", "ntfy"]),
      thirdCountry: transfersOf(s, ["cloudflare_email", "ntfy"]),
      retention: "Gelesene Hinweise 90 Tage",
    },
  ];
  if (s.some((x) => x.id === "claude")) {
    activities.push({
      name: "Beleg-Erkennung (optional)",
      purpose: "Automatisches Auslesen von Eingangsbelegen",
      legalBasis: "Art. 6 Abs. 1 lit. f DSGVO",
      subjects: "Lieferanten",
      data: "Belegbilder und -texte",
      recipients: recipientsOf(s, ["claude"]),
      thirdCountry: transfersOf(s, ["claude"]),
      retention: "Keine Speicherung beim Anbieter über die Verarbeitung hinaus (laut AVV prüfen)",
    });
  }
  return {
    title: "Verzeichnis von Verarbeitungstätigkeiten (Art. 30 Abs. 1 DSGVO)",
    stand: i.today,
    controller: i.controller,
    dpo:
      i.dpo?.trim() ||
      "Nicht benannt (keine Pflicht nach § 38 BDSG, sofern weniger als 20 Personen ständig mit der Verarbeitung beschäftigt sind)",
    activities,
    toms: [
      "Zugang nur über Anmeldung mit Passkey oder E-Mail-Code, Rollen je Mitglied, Prüferzugang befristet",
      "Verschlüsselte Übertragung (TLS), Server im eigenen Netz, Zugang über tailnet bzw. Cloudflare-Tunnel",
      "Hash-verkettetes, unveränderliches Änderungsprotokoll mit täglicher Integritätsprüfung und signierten Prüfpunkten",
      "Tägliche Datensicherung außerhalb des Servers, dokumentierte Wiederherstellungstests",
      "Personenbezogene Werte im Protokoll je Kontakt verschlüsselt (Crypto-Shredding nach Ablauf der Aufbewahrung)",
    ],
  };
}

export function art30Markdown(r: Art30Record): string {
  const lines = [
    `# ${r.title}`,
    "",
    `Stand: ${r.stand}`,
    "",
    "## Verantwortlicher",
    "",
    `${r.controller.name}, ${r.controller.address}${r.controller.email ? `, ${r.controller.email}` : ""}`,
    ...(r.controller.representative ? [`Vertreten durch: ${r.controller.representative}`] : []),
    "",
    `Datenschutzbeauftragter: ${r.dpo}`,
    "",
    "## Verarbeitungstätigkeiten",
  ];
  for (const a of r.activities) {
    lines.push(
      "",
      `### ${a.name}`,
      "",
      `- Zweck: ${a.purpose}`,
      `- Rechtsgrundlage: ${a.legalBasis}`,
      `- Betroffene: ${a.subjects}`,
      `- Datenkategorien: ${a.data}`,
      `- Empfänger: ${a.recipients}`,
      `- Drittlandübermittlung: ${a.thirdCountry}`,
      `- Löschfrist: ${a.retention}`,
    );
  }
  lines.push("", "## Technische und organisatorische Maßnahmen (Art. 32 DSGVO)", "", ...r.toms.map((t) => `- ${t}`));
  return `${lines.join("\n")}\n`;
}
