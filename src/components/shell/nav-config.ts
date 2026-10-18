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
export type NavGroupKey = keyof (typeof messages)["nav"]["groups"];
export type SettingsKey = keyof (typeof messages)["settings"]["items"];
export type SettingsGroupKey = keyof (typeof messages)["settings"]["groups"];

export interface NavItem {
  key: NavKey;
  href: Route;
  icon: LucideIcon;
  /** Sub-items, shown in the sidebar only while this area is active (sevdesk pattern, NAV-002). */
  children?: NavItem[];
}

export interface NavGroup {
  key: NavGroupKey | "main";
  items: NavItem[];
}

/**
 * Sidebar (04-ui-ux §3.2, NAV-001): sevdesk's areas, then „Verwalten“. An area without its own list page links to
 * its first sub-item (Aufträge → Angebote, Bank → Bankkonten, Steuern → UStVA, Auswertungen → Offene Posten).
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    key: "main",
    items: [
      { key: "start", href: "/", icon: HouseIcon },
      {
        key: "auftraegeBereich",
        href: "/angebote",
        icon: FileTextIcon,
        children: [
          { key: "angebote", href: "/angebote", icon: FileTextIcon },
          { key: "auftraege", href: "/auftraege", icon: ClipboardCheckIcon },
          { key: "lieferscheine", href: "/lieferscheine", icon: TruckIcon },
        ],
      },
      {
        key: "rechnungen",
        href: "/rechnungen",
        icon: ReceiptIcon,
        children: [
          { key: "wiederkehrend", href: "/rechnungen/wiederkehrend", icon: RepeatIcon },
          { key: "mahnungen", href: "/mahnungen", icon: SirenIcon },
        ],
      },
      {
        key: "belege",
        href: "/belege",
        icon: ReceiptTextIcon,
        children: [
          { key: "posteingang", href: "/posteingang", icon: InboxIcon },
          { key: "anlagen", href: "/buchhaltung/anlagen", icon: Building2Icon },
        ],
      },
      {
        key: "bankBereich",
        href: "/bank",
        icon: LandmarkIcon,
        children: [
          { key: "bank", href: "/bank", icon: LandmarkIcon },
          { key: "kasse", href: "/kasse", icon: WalletIcon },
          { key: "zuordnungen", href: "/bank/zuordnungen", icon: ArrowLeftRightIcon },
        ],
      },
      {
        key: "steuernBereich",
        href: "/steuern/ustva",
        icon: PercentIcon,
        children: [
          { key: "ustva", href: "/steuern/ustva", icon: PercentIcon },
          { key: "euer", href: "/steuern/euer", icon: CalculatorIcon },
          { key: "zm", href: "/steuern/zm", icon: GlobeIcon },
          { key: "ustJahr", href: "/steuern/ust-jahr", icon: CalendarRangeIcon },
          { key: "ruecklage", href: "/steuern/ruecklage", icon: PiggyBankIcon },
        ],
      },
      {
        key: "auswertungenBereich",
        href: "/auswertungen/offene-posten",
        icon: ChartColumnIcon,
        children: [
          { key: "offenePosten", href: "/auswertungen/offene-posten", icon: ListChecksIcon },
          { key: "liquiditaet", href: "/auswertungen/liquiditaet", icon: TrendingUpIcon },
          { key: "journal", href: "/buchhaltung/journal", icon: BookOpenIcon },
          { key: "konten", href: "/buchhaltung/konten", icon: ListTreeIcon },
          { key: "eroeffnung", href: "/buchhaltung/eroeffnung", icon: BookMarkedIcon },
          { key: "festschreibung", href: "/buchhaltung/festschreibung", icon: LockIcon },
          { key: "export", href: "/export", icon: DownloadIcon },
        ],
      },
    ],
  },
  {
    key: "verwalten",
    items: [
      { key: "kontakte", href: "/kontakte", icon: UsersIcon },
      { key: "produkte", href: "/produkte", icon: PackageIcon },
      { key: "einstellungen", href: "/einstellungen", icon: SettingsIcon },
    ],
  },
];

/** Pages without a sidebar entry (NAV-004): reachable through the command palette, the top bar or the account menu. */
export const SECONDARY_NAV: NavItem[] = [
  { key: "auswertungen", href: "/auswertungen", icon: ChartColumnIcon },
  { key: "zeiten", href: "/zeiten", icon: ClockIcon },
  { key: "projekte", href: "/projekte", icon: FolderKanbanIcon },
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
      { key: "mahnwesen", href: "/einstellungen/mahnwesen" },
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

const SIDEBAR_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Every navigable page once: an area that only opens its first sub-item is not listed separately. */
export const ALL_NAV_ITEMS: NavItem[] = [
  ...SIDEBAR_ITEMS.flatMap((item) => {
    const children = item.children ?? [];
    return children.some((c) => c.href === item.href) ? children : [item, ...children];
  }),
  ...SECONDARY_NAV,
];

/** Command palette pages (NAV-004). */
export const PALETTE_NAV_ITEMS: NavItem[] = ALL_NAV_ITEMS;

function matches(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The page whose href is the longest prefix of the pathname (so /rechnungen/wiederkehrend wins). */
export function findActiveNavItem(pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const item of ALL_NAV_ITEMS) {
    if (matches(pathname, item.href) && (!best || item.href.length > best.href.length)) best = item;
  }
  return best;
}

/** The sidebar area a page belongs to (itself for top-level pages). */
export function findAreaOf(key: NavKey): NavItem | undefined {
  return SIDEBAR_ITEMS.find((i) => i.key === key || i.children?.some((c) => c.key === key));
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
