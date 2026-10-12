import { ArrowRightIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.start");
  return { title: t("title") };
}

/** Dashboard skeleton (04-ui-ux §4.7): responsive widget grid via container queries. */
export default async function StartPage() {
  const t = await getTranslations("pages.start");
  const widgets = ["receivables", "revenue", "todos", "activity"] as const;
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Link href="/einrichtung" className={buttonVariants()}>
            {t("action")}
            <ArrowRightIcon aria-hidden="true" />
          </Link>
        }
      />
      <PageBody>
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
        <div className="grid gap-4 @2xl/main:grid-cols-2 @6xl/main:grid-cols-4">
          {widgets.map((w) => (
            <Card key={w} size="sm">
              <CardHeader>
                <CardTitle>
                  <h2 className="font-medium text-base">{t(`widgets.${w}`)}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground text-sm">{t("widgets.noData")}</CardContent>
            </Card>
          ))}
        </div>
      </PageBody>
    </>
  );
}
