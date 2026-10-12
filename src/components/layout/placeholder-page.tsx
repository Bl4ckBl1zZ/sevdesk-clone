import { ConstructionIcon, type LucideIcon } from "lucide-react";
import type { Metadata, Route } from "next";
import { getTranslations } from "next-intl/server";
import { findSectionOf, NAV_SECTIONS, type NavKey } from "@/components/shell/nav-config";
import type messages from "@/i18n/messages/de.json";
import { EmptyState } from "./empty-state";
import { PageBody } from "./list-layout";
import { type Breadcrumb, PageHeader } from "./page-header";

type Pages = (typeof messages)["pages"];
export type PageKey = keyof Pages;
type PagesWithAction = { [K in PageKey]: Pages[K] extends { action: string } ? K : never }[PageKey];

/** Primary actions of empty states ("Erste Rechnung erstellen", 04-ui-ux §4.1). */
const ACTIONS: Partial<Record<PagesWithAction, Route>> = {
  angebote: "/angebote/neu",
  rechnungen: "/rechnungen/neu",
  belege: "/posteingang",
  bank: "/einstellungen/bank",
  kontakte: "/kontakte/neu",
  produkte: "/produkte/neu",
};

/** Pages that are not a nav item themselves but belong to one (for breadcrumb + icon). */
const PARENT: Partial<Record<PageKey, NavKey>> = {
  angeboteNeu: "angebote",
  rechnungenNeu: "rechnungen",
  kontakteNeu: "kontakte",
  produkteNeu: "produkte",
};

function navInfo(page: PageKey): { icon: LucideIcon; navKey?: NavKey } {
  const navKey = (PARENT[page] ?? page) as NavKey;
  const item = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.key === navKey);
  return { icon: item?.icon ?? ConstructionIcon, navKey: item ? navKey : undefined };
}

export async function placeholderMetadata(page: PageKey): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t(`${page}.title`) };
}

/** Minimal P0 page: header + empty state, so navigation works end to end (04-ui-ux §3.4, §4.1). */
export async function PlaceholderPage({ page }: { page: PageKey }) {
  const t = await getTranslations("pages");
  const tNav = await getTranslations("nav");
  const tEmpty = await getTranslations("emptyState");
  const { icon, navKey } = navInfo(page);

  const breadcrumbs: Breadcrumb[] = [];
  const section = navKey ? findSectionOf(navKey) : undefined;
  if (section && section.key !== "main") breadcrumbs.push({ label: tNav(`sections.${section.key}`) });
  if (PARENT[page] && navKey) {
    const parent = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.key === navKey);
    if (parent) breadcrumbs.push({ label: tNav(`items.${parent.key}`), href: parent.href });
  }
  breadcrumbs.push({ label: t(`${page}.title`) });

  const actionHref = ACTIONS[page as PagesWithAction];
  const action = actionHref ? { label: t(`${page as PagesWithAction}.action`), href: actionHref } : undefined;

  return (
    <>
      <PageHeader title={t(`${page}.title`)} description={t(`${page}.description`)} breadcrumbs={breadcrumbs} />
      <PageBody>
        <EmptyState icon={icon} title={t(`${page}.empty`)} description={tEmpty("building")} action={action} />
      </PageBody>
    </>
  );
}
