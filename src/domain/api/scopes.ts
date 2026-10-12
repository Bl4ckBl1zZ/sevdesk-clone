import { RESERVED_SCOPES, SCOPES, type Scope } from "../schemas/scopes";

/**
 * Scope presets and groups for the key dialog (05 §2.2). Reserved scopes (`portal:manage`, F10 deferred) are never
 * offered; members, roles, sign-in settings, API keys, secrets, purge and restore have no scope at all
 * (never grantable via API).
 */
export const GRANTABLE_SCOPES: readonly Scope[] = SCOPES.filter((s) => !RESERVED_SCOPES.includes(s));

export function isGrantableScope(value: string): value is Scope {
  return (GRANTABLE_SCOPES as readonly string[]).includes(value);
}

const READ_SCOPES: readonly Scope[] = GRANTABLE_SCOPES.filter((s) => s.endsWith(":read"));

export const SCOPE_PRESETS = {
  website: ["contacts:read", "contacts:write", "products:read", "documents:read", "documents:write", "payments:read"],
  claude_safe: [...READ_SCOPES, "contacts:write", "products:write", "documents:write", "vouchers:write"],
  claude_full: [
    ...READ_SCOPES,
    "contacts:write",
    "products:write",
    "documents:write",
    "vouchers:write",
    "invoices:finalize",
    "invoices:send",
    "invoices:cancel",
    "payments:write",
    "dunning:write",
  ],
  read_only: [...READ_SCOPES],
} as const satisfies Record<string, readonly Scope[]>;

export type ScopePreset = keyof typeof SCOPE_PRESETS;
export const SCOPE_PRESET_KEYS = Object.keys(SCOPE_PRESETS) as ScopePreset[];

export const SCOPE_PRESET_LABELS: Readonly<Record<ScopePreset, string>> = {
  website: "Website",
  claude_safe: "Claude (MCP), sicher",
  claude_full: "Claude (MCP), voll",
  read_only: "Nur lesen",
};

/** Default channel of a preset (the dialog pre-selects it; the owner may change it). */
export const SCOPE_PRESET_CHANNEL: Readonly<Record<ScopePreset, "api" | "mcp" | "both">> = {
  website: "api",
  claude_safe: "mcp",
  claude_full: "mcp",
  read_only: "both",
};

export function presetScopes(preset: ScopePreset): Scope[] {
  return [...new Set<Scope>(SCOPE_PRESETS[preset])].sort();
}

/** The preset whose scope set equals `scopes` exactly, if any (shown as a badge in the key list). */
export function matchingPreset(scopes: readonly string[]): ScopePreset | null {
  const set = [...new Set(scopes)].sort().join(" ");
  return SCOPE_PRESET_KEYS.find((p) => presetScopes(p).join(" ") === set) ?? null;
}

/** Checkbox groups by area (05 §2.2 table order) with German labels. */
export const SCOPE_GROUPS: readonly { key: string; label: string; scopes: readonly Scope[] }[] = [
  { key: "contacts", label: "Kontakte", scopes: ["contacts:read", "contacts:write"] },
  { key: "products", label: "Produkte", scopes: ["products:read", "products:write"] },
  {
    key: "documents",
    label: "Dokumente",
    scopes: ["documents:read", "documents:write", "invoices:finalize", "invoices:send", "invoices:cancel"],
  },
  {
    key: "payments",
    label: "Zahlungen und Mahnwesen",
    scopes: ["payments:read", "payments:write", "dunning:write", "dunning:manage"],
  },
  { key: "vouchers", label: "Belege", scopes: ["vouchers:read", "vouchers:write"] },
  { key: "banking", label: "Bank und Kasse", scopes: ["banking:read", "banking:write"] },
  {
    key: "accounting",
    label: "Buchhaltung, Steuern, Berichte",
    scopes: ["accounting:read", "accounting:write", "reports:read"],
  },
  { key: "data", label: "Export und Import", scopes: ["exports:run", "imports:run"] },
  {
    key: "settings",
    label: "Einstellungen",
    scopes: ["settings:read", "settings:write", "company:public", "webhooks:manage", "audit:read"],
  },
  { key: "projects", label: "Projekte und Zeiten (P4)", scopes: ["projects:read", "projects:write", "time:write"] },
];

/** German description per scope (05 §2.2 „Grants"). */
export const SCOPE_LABELS: Readonly<Record<Scope, string>> = {
  "contacts:read": "Kontakte lesen",
  "contacts:write": "Kontakte anlegen und ändern",
  "products:read": "Produkte lesen",
  "products:write": "Produkte anlegen und ändern",
  "documents:read": "Dokumente lesen und exportieren",
  "documents:write": "Entwürfe anlegen und ändern",
  "invoices:finalize": "Dokumente fertigstellen (unumkehrbar)",
  "invoices:send": "Als versendet markieren",
  "invoices:cancel": "Stornieren",
  "payments:read": "Zahlungen und offene Posten lesen",
  "payments:write": "Zahlungen erfassen und stornieren",
  "dunning:write": "Mahnungen erstellen und Mahnlauf",
  "dunning:manage": "Mahnstufen und -regeln ändern",
  "vouchers:read": "Belege lesen",
  "vouchers:write": "Belege hochladen und bearbeiten",
  "banking:read": "Bank und Kasse lesen",
  "banking:write": "Kontoauszüge importieren und zuordnen",
  "accounting:read": "Journal und Konten lesen",
  "accounting:write": "Buchungen und Abgaben erfassen",
  "reports:read": "Auswertungen lesen",
  "exports:run": "Exporte erstellen",
  "imports:run": "Daten importieren",
  "settings:read": "Einstellungen lesen",
  "settings:write": "Einstellungen ändern (ohne Geheimnisse)",
  "webhooks:manage": "Webhooks verwalten",
  "audit:read": "Protokoll lesen",
  "projects:read": "Projekte lesen",
  "projects:write": "Projekte ändern",
  "time:write": "Zeiten erfassen",
  "portal:manage": "Kundenportal (reserviert)",
  "company:public": "Öffentliche Firmendaten (Impressum)",
};
