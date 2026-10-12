import { SettingsIcon } from "lucide-react";
import type { Metadata, Route } from "next";
import { getTranslations } from "next-intl/server";
import type * as React from "react";
import { EmptyState } from "@/components/layout/empty-state";
import { PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";
import type { SettingsKey } from "@/components/shell/nav-config";

export async function settingsMetadata(key: SettingsKey): Promise<Metadata> {
  const t = await getTranslations("settings.items");
  return { title: t(key) };
}

/** Frame of a settings sub-page: header with breadcrumb and optional primary action. */
export async function SettingsPage({
  item,
  sub,
  actions,
  children,
}: {
  item: SettingsKey;
  /** A sub-page of `item` (e.g. System › Sicherheit). */
  sub?: { title: string; description: string };
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = await getTranslations("settings");
  const crumbs = sub
    ? [
        { label: t("navLabel"), href: "/einstellungen" },
        { label: t(`items.${item}`), href: `/einstellungen/${item}` as Route },
        { label: sub.title },
      ]
    : [{ label: t("navLabel"), href: "/einstellungen" }, { label: t(`items.${item}`) }];
  return (
    <>
      <PageHeader
        title={sub?.title ?? t(`items.${item}`)}
        description={sub?.description ?? t(`descriptions.${item}`)}
        breadcrumbs={crumbs}
        actions={actions}
      />
      <PageBody>{children}</PageBody>
    </>
  );
}

/** Settings areas owned by later phases or other specs (members, API, MCP, audit, …). */
export async function SettingsPlaceholder({ item }: { item: SettingsKey }) {
  const t = await getTranslations("settings");
  const tEmpty = await getTranslations("emptyState");
  return (
    <SettingsPage item={item}>
      <EmptyState icon={SettingsIcon} title={t("comingSoon")} description={tEmpty("building")} />
    </SettingsPage>
  );
}
