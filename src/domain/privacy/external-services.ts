/**
 * External services and processors (F12 PRV-016, F01 SET-048/109/114; 01 DSGVO-04, AO-06). Pure.
 *
 * The catalog lists every service the deployment can talk to, with its role under the DSGVO, the data it receives,
 * where it processes data and the provider's DPA. `configuredServices()` selects the ones in use from the settings
 * and the deployment, and attaches the owner's AVV confirmation. Non-EU processing without a confirmed AVV is a
 * warning (E-AUD-24) — never a block for Cloudflare Email, because sign-in must keep working (SET-109).
 *
 * LEGAL-OPEN: 01 DSGVO-04 — the regions below are the providers' published defaults (2026-10); a provider-specific
 * transfer basis (EU-US Data Privacy Framework, SCC) is recorded by the owner with the AVV confirmation, not inferred.
 */

export type ServiceRole = "processor" | "independent" | "public_authority";
export type ServiceRegion = "EU" | "DE" | "US" | "global" | "self_hosted" | "unknown";

export interface ExternalServiceDef {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly role: ServiceRole;
  readonly purpose: string;
  readonly dataCategories: string;
  readonly region: ServiceRegion;
  readonly dpaUrl?: string;
  /** Requirement the service backs (for the Verfahrensdokumentation chapter 15). */
  readonly phase: "P0" | "P1" | "P2" | "P3";
}

export const EXTERNAL_SERVICES: readonly ExternalServiceDef[] = [
  {
    id: "cloudflare_email",
    name: "Cloudflare Email Sending",
    provider: "Cloudflare, Inc.",
    role: "processor",
    purpose: "Anmelde-Codes, Einladungen und Benachrichtigungen an Mitglieder",
    dataCategories: "E-Mail-Adressen der Mitglieder, Anmelde-Codes, kurze Benachrichtigungstexte",
    region: "global",
    dpaUrl: "https://www.cloudflare.com/cloudflare-customer-dpa/",
    phase: "P0",
  },
  {
    id: "cloudflare_r2",
    name: "Cloudflare R2 (Sicherungen, Prüfpunkte)",
    provider: "Cloudflare, Inc.",
    role: "processor",
    purpose: "Datenbanksicherungen und signierte Prüfpunkte außerhalb des Servers",
    dataCategories: "Vollständige Geschäftsdaten (verschlüsselte Sicherungen), Prüfpunkte ohne Personenbezug",
    region: "EU",
    dpaUrl: "https://www.cloudflare.com/cloudflare-customer-dpa/",
    phase: "P0",
  },
  {
    id: "cloudflare_r2_inbox",
    name: "Cloudflare R2 + Email Routing (Belegeingang)",
    provider: "Cloudflare, Inc.",
    role: "processor",
    purpose: "Empfang von Belegen per E-Mail",
    dataCategories: "Eingehende E-Mails mit Belegen (Absender, Inhalte)",
    region: "global",
    dpaUrl: "https://www.cloudflare.com/cloudflare-customer-dpa/",
    phase: "P2",
  },
  {
    id: "cloudflare_edge",
    name: "Cloudflare Tunnel und DNS (öffentlicher Zugang)",
    provider: "Cloudflare, Inc.",
    role: "processor",
    purpose: "TLS-Zugang zur App über das Internet (öffentlicher Edge-Modus) und DNS für die Domain",
    dataCategories: "Gesamter Datenverkehr der App (TLS-terminiert), IP-Adressen der Nutzer",
    region: "global",
    dpaUrl: "https://www.cloudflare.com/cloudflare-customer-dpa/",
    phase: "P1",
  },
  {
    id: "tailscale",
    name: "Tailscale",
    provider: "Tailscale Inc.",
    role: "processor",
    purpose: "Koordination des privaten Netzwerks (tailnet)",
    dataCategories: "Geräte- und Benutzer-Metadaten; Nutzdaten sind Ende-zu-Ende verschlüsselt",
    region: "US",
    dpaUrl: "https://tailscale.com/dpa",
    phase: "P0",
  },
  {
    id: "lets_encrypt",
    name: "Let's Encrypt",
    provider: "Internet Security Research Group",
    role: "independent",
    purpose: "Ausstellung von TLS-Zertifikaten",
    dataCategories: "Hostnamen (keine personenbezogenen Daten)",
    region: "US",
    phase: "P0",
  },
  {
    id: "claude",
    name: "Anthropic Claude (Beleg-Erkennung, optional)",
    provider: "Anthropic PBC",
    role: "processor",
    purpose: "Texterkennung von Belegen (nur wenn eingeschaltet)",
    dataCategories: "Belegbilder und -texte",
    region: "US",
    dpaUrl: "https://www.anthropic.com/legal/dpa",
    phase: "P2",
  },
  {
    id: "enable_banking",
    name: "Enable Banking",
    provider: "Enable Banking Oy",
    role: "processor",
    purpose: "Kontoinformationsdienst (PSD2) für den Abruf der Revolut-Umsätze",
    dataCategories: "Kontodaten, Umsätze, Gegenparteien",
    region: "EU",
    dpaUrl: "https://enablebanking.com/legal/",
    phase: "P2",
  },
  {
    id: "ntfy",
    name: "ntfy (Push-Benachrichtigungen)",
    provider: "Betreiber des ntfy-Servers",
    role: "processor",
    purpose: "Push-Benachrichtigungen an das Telefon des Inhabers",
    dataCategories: "Kurze Hinweistexte (ohne Kundennamen und Beträge, außer „Details senden“)",
    region: "self_hosted",
    phase: "P1",
  },
  {
    id: "evatr",
    name: "BZSt eVatR (USt-IdNr.-Prüfung)",
    provider: "Bundeszentralamt für Steuern",
    role: "public_authority",
    purpose: "Bestätigung ausländischer USt-IdNrn. (§ 18e UStG)",
    dataCategories: "USt-IdNr., Name und Anschrift des Kunden",
    region: "DE",
    phase: "P1",
  },
  {
    id: "vies",
    name: "EU VIES",
    provider: "Europäische Kommission",
    role: "public_authority",
    purpose: "Prüfung von USt-IdNrn. im EU-Verzeichnis",
    dataCategories: "USt-IdNr.",
    region: "EU",
    phase: "P1",
  },
];

export const ROLE_LABEL_DE: Readonly<Record<ServiceRole, string>> = {
  processor: "Auftragsverarbeiter",
  independent: "Eigener Verantwortlicher",
  public_authority: "Behörde (keine Auftragsverarbeitung)",
};

export const REGION_LABEL_DE: Readonly<Record<ServiceRegion, string>> = {
  EU: "EU",
  DE: "Deutschland",
  US: "USA",
  global: "Weltweit (inkl. USA)",
  self_hosted: "Eigener Server",
  unknown: "Unbekannt",
};

export const isEuRegion = (r: ServiceRegion): boolean => r === "EU" || r === "DE" || r === "self_hosted";

/** SET-048: bundled provider-region table for configured endpoints (host suffix → region). */
const HOST_REGIONS: readonly [RegExp, ServiceRegion][] = [
  [/\.eu\.r2\.cloudflarestorage\.com$/i, "EU"],
  [/\.r2\.cloudflarestorage\.com$/i, "global"],
  [/(^|\.)api\.anthropic\.com$/i, "US"],
  [/(^|\.)enablebanking\.com$/i, "EU"],
  [/(^|\.)ntfy\.sh$/i, "unknown"],
  [/\.ts\.net$/i, "self_hosted"],
  [/(^|\.)(localhost|local)$/i, "self_hosted"],
];

export function regionOfEndpoint(url: string, declared?: string): ServiceRegion {
  if (declared) {
    const d = declared.trim().toUpperCase();
    if (d === "EU" || d === "EEA") return "EU";
    if (d === "DE") return "DE";
    if (d === "US") return "US";
  }
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return "unknown";
  }
  for (const [re, region] of HOST_REGIONS) if (re.test(host)) return region;
  return "unknown";
}

export interface ServiceUsage {
  /** Service ids in use with an optional region detected from the configured endpoint. */
  readonly inUse: readonly { id: string; region?: ServiceRegion | undefined; detail?: string | undefined }[];
  /** Owner AVV confirmations (epoch ms) by service id. */
  readonly avv: Readonly<Record<string, number | undefined>>;
}

export interface ConfiguredService extends ExternalServiceDef {
  readonly effectiveRegion: ServiceRegion;
  readonly detail?: string | undefined;
  readonly avvConfirmedAt: number | null;
  /** AVV needed (processor) but not confirmed. */
  readonly avvMissing: boolean;
  /** E-AUD-24 warning text, if any. */
  readonly warning: string | null;
}

export const nonEuWarning = (service: string): string =>
  `${service} verarbeitet Daten außerhalb der EU. Auftragsverarbeitungsvertrag und § 146 Abs. 2 AO beachten.`;

export function configuredServices(usage: ServiceUsage): ConfiguredService[] {
  const out: ConfiguredService[] = [];
  for (const u of usage.inUse) {
    const def = EXTERNAL_SERVICES.find((s) => s.id === u.id);
    if (!def) continue;
    const region = u.region ?? def.region;
    const avvConfirmedAt = usage.avv[def.id] ?? null;
    const avvMissing = def.role === "processor" && avvConfirmedAt === null;
    const warning =
      def.role !== "public_authority" && !isEuRegion(region) && avvMissing ? nonEuWarning(def.name) : null;
    out.push({ ...def, effectiveRegion: region, detail: u.detail, avvConfirmedAt, avvMissing, warning });
  }
  return out;
}
