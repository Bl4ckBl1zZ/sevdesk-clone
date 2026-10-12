import { ChevronRightIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";
import { SETTINGS_NAV } from "@/components/shell/nav-config";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.einstellungen");
  return { title: t("title") };
}

export default async function SettingsIndexPage() {
  const t = await getTranslations();
  return (
    <>
      <PageHeader title={t("pages.einstellungen.title")} description={t("pages.einstellungen.description")} />
      <PageBody className="gap-6">
        {SETTINGS_NAV.map((group) => (
          <section key={group.key} aria-labelledby={`einstellungen-${group.key}`} className="flex flex-col gap-2">
            <h2 id={`einstellungen-${group.key}`} className="font-medium text-muted-foreground text-sm">
              {t(`settings.groups.${group.key}`)}
            </h2>
            <ul className="divide-y rounded-lg border">
              {group.items.map((item) => (
                <li key={item.key}>
                  <Link href={item.href} className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-muted">
                    <span className="flex flex-1 flex-col">
                      <span className="font-medium text-sm">{t(`settings.items.${item.key}`)}</span>
                      <span className="text-muted-foreground text-xs">{t(`settings.descriptions.${item.key}`)}</span>
                    </span>
                    <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </PageBody>
    </>
  );
}
