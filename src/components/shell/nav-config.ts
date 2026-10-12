/**
 * Navigation model (04-ui-ux §3.2–3.4). Single source for the sidebar, the mobile "Mehr" sheet, the bottom tab
 * bar, the command palette, page titles and breadcrumbs.
 */
import {
  ArrowLeftRightIcon,
  BellIcon,
  BookMarkedIcon,
  BookOpenIcon,
  Building2Icon,
  CalculatorIcon,
  CalendarRangeIcon,
  ChartColumnIcon,
  ClipboardCheckIcon,
  ClockIcon,
  DownloadIcon,
  FileTextIcon,
  FolderKanbanIcon,
  GlobeIcon,
  HouseIcon,
  InboxIcon,
  LandmarkIcon,
  ListChecksIcon,
  ListTreeIcon,
  LockIcon,
  type LucideIcon,
  PackageIcon,
  PercentIcon,
  PiggyBankIcon,
  ReceiptIcon,
  ReceiptTextIcon,
  RepeatIcon,
  SettingsIcon,
  SirenIcon,
  TrendingUpIcon,
  TruckIcon,
  UserRoundIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";
import type { Route } from "next";
import type messages from "@/i18n/messages/de.json";

export type NavKey = keyof (typeof messages)["nav"]["items"];
export type NavSectionKey = keyof (typeof messages)["nav"]["sections"];
export type SettingsKey = keyof (typeof messages)["settings"]["items"];
export type SettingsGroupKey = keyof (typeof messages)["settings"]["groups"];

export interface NavItem {
  key: NavKey;
  href: Route;
  icon: LucideIcon;
}

export interface NavSection {
  key: NavSectionKey | "main";
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  { key: "main", items: [{ key: "start", href: "/", icon: HouseIcon }] },
  {
    key: "verkauf",
    items: [
      { key: "angebote", href: "/angebote", icon: FileTextIcon },
      { key: "auftraege", href: "/auftraege", icon: ClipboardCheckIcon },
      { key: "lieferscheine", href: "/lieferscheine", icon: TruckIcon },
      { key: "rechnungen", href: "/rechnungen", icon: ReceiptIcon },
      { key: "wiederkehrend", href: "/rechnungen/wiederkehrend", icon: RepeatIcon },
      { key: "mahnungen", href: "/mahnungen", icon: SirenIcon },
    ],
  },
  {
    key: "einkauf",
    items: [
      { key: "belege", href: "/belege", icon: ReceiptTextIcon },
      { key: "posteingang", href: "/posteingang", icon: InboxIcon },
    ],
  },
  {
    key: "bank",
    items: [
      { key: "bank", href: "/bank", icon: LandmarkIcon },
      { key: "zuordnungen", href: "/bank/zuordnungen", icon: ArrowLeftRightIcon },
      { key: "kasse", href: "/kasse", icon: WalletIcon },
    ],
  },
  {
    key: "stammdaten",
    items: [
      { key: "kontakte", href: "/kontakte", icon: UsersIcon },
      { key: "produkte", href: "/produkte", icon: PackageIcon },
    ],
  },
  {
    key: "zeiten",
    items: [
      { key: "zeiten", href: "/zeiten", icon: ClockIcon },
      { key: "projekte", href: "/projekte", icon: FolderKanbanIcon },
    ],
  },
  {
    key: "buchhaltung",
    items: [
      { key: "journal", href: "/buchhaltung/journal", icon: BookOpenIcon },
      { key: "konten", href: "/buchhaltung/konten", icon: ListTreeIcon },
      { key: "eroeffnung", href: "/buchhaltung/eroeffnung", icon: BookMarkedIcon },
      { key: "anlagen", href: "/buchhaltung/anlagen", icon: Building2Icon },
      { key: "festschreibung", href: "/buchhaltung/festschreibung", icon: LockIcon },
    ],
  },
  {
    key: "steuern",
    items: [
      { key: "ustva", href: "/steuern/ustva", icon: PercentIcon },
      { key: "zm", href: "/steuern/zm", icon: GlobeIcon },
      { key: "euer", href: "/steuern/euer", icon: CalculatorIcon },
      { key: "ustJahr", href: "/steuern/ust-jahr", icon: CalendarRangeIcon },
      { key: "ruecklage", href: "/steuern/ruecklage", icon: PiggyBankIcon },
    ],
  },
  {
    key: "auswertungen",
    items: [
      { key: "auswertungen", href: "/auswertungen", icon: ChartColumnIcon },
      { key: "offenePosten", href: "/auswertungen/offene-posten", icon: ListChecksIcon },
      { key: "liquiditaet", href: "/auswertungen/liquiditaet", icon: TrendingUpIcon },
      { key: "export", href: "/export", icon: DownloadIcon },
    ],
  },
];

/** Items outside the main sections (sidebar footer, top bar). */
export const SECONDARY_NAV: NavItem[] = [
  { key: "einstellungen", href: "/einstellungen", icon: SettingsIcon },
  { key: "benachrichtigungen", href: "/benachrichtigungen", icon: BellIcon },
  { key: "konto", href: "/konto", icon: UserRoundIcon },
];

export interface SettingsItem {
  key: SettingsKey;
  href: Route;
}

export interface SettingsGroup {
  key: SettingsGroupKey;
  items: SettingsItem[];
}

/** `/einstellungen/**` (04-ui-ux §3.4, F01 §6.1). */
export const SETTINGS_NAV: SettingsGroup[] = [
  {
    key: "unternehmen",
    items: [
      { key: "unternehmen", href: "/einstellungen/unternehmen" },
      { key: "steuern", href: "/einstellungen/steuern" },
      { key: "bank", href: "/einstellungen/bank" },
    ],
  },
  {
    key: "dokumente",
    items: [
      { key: "nummernkreise", href: "/einstellungen/nummernkreise" },
      { key: "layouts", href: "/einstellungen/layouts" },
      { key: "textvorlagen", href: "/einstellungen/textvorlagen" },
      { key: "stammdaten", href: "/einstellungen/stammdaten" },
      { key: "regeln", href: "/einstellungen/regeln" },
    ],
  },
  {
    key: "zugriff",
    items: [
      { key: "mitglieder", href: "/einstellungen/mitglieder" },
      { key: "integrationen", href: "/einstellungen/integrationen" },
      { key: "api", href: "/einstellungen/api" },
      { key: "webhooks", href: "/einstellungen/webhooks" },
      { key: "mcp", href: "/einstellungen/mcp" },
      { key: "import", href: "/einstellungen/import" },
      { key: "benachrichtigungen", href: "/einstellungen/benachrichtigungen" },
    ],
  },
  {
    key: "system",
    items: [
      { key: "audit", href: "/einstellungen/audit" },
      { key: "datenschutz", href: "/einstellungen/datenschutz" },
      { key: "verfahrensdokumentation", href: "/einstellungen/verfahrensdokumentation" },
      { key: "system", href: "/einstellungen/system" },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = [...NAV_SECTIONS.flatMap((s) => s.items), ...SECONDARY_NAV];

function matches(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The nav item whose href is the longest prefix of the pathname (so /rechnungen/wiederkehrend wins). */
export function findActiveNavItem(pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const item of ALL_NAV_ITEMS) {
    if (matches(pathname, item.href) && (!best || item.href.length > best.href.length)) best = item;
  }
  return best;
}

export function findSectionOf(key: NavKey): NavSection | undefined {
  return NAV_SECTIONS.find((s) => s.items.some((i) => i.key === key));
}

export function findActiveSettingsItem(pathname: string): SettingsItem | undefined {
  return SETTINGS_NAV.flatMap((g) => g.items).find((i) => matches(pathname, i.href));
}

/** Mobile bottom tabs (04-ui-ux §3.3): Start · Rechnungen · Neu · Beleg · Mehr. */
export const MOBILE_TABS: NavItem[] = [
  { key: "start", href: "/", icon: HouseIcon },
  { key: "rechnungen", href: "/rechnungen", icon: ReceiptIcon },
];

export type CreateKey = keyof (typeof messages)["shell"]["create"];

/** "Neu" menu (04-ui-ux §3.3): Rechnung, Angebot, Kontakt, Produkt, Zeit erfassen, Beleg. */
export const CREATE_ITEMS: { key: CreateKey; href: Route; icon: LucideIcon }[] = [
  { key: "rechnung", href: "/rechnungen/neu", icon: ReceiptIcon },
  { key: "angebot", href: "/angebote/neu", icon: FileTextIcon },
  { key: "kontakt", href: "/kontakte/neu", icon: UsersIcon },
  { key: "produkt", href: "/produkte/neu", icon: PackageIcon },
  { key: "zeit", href: "/zeiten", icon: ClockIcon },
  { key: "beleg", href: "/posteingang", icon: ReceiptTextIcon },
];
