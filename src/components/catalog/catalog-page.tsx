import type { Metadata, Route } from "next";
import { getTranslations } from "next-intl/server";
import type * as React from "react";
import { RoleGate } from "@/components/auth/role-gate";
import { PageBody } from "@/components/layout/list-layout";
import { type Breadcrumb, PageHeader } from "@/components/layout/page-header";
import type { PageKey } from "@/components/layout/placeholder-page";
import type { Permission } from "@/domain/access/permissions";

/** Pages of the contact and product screens (F02 §6, F03 §6) with header, breadcrumb and role gate. */
export async function catalogMetadata(page: PageKey): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t(`${page}.title`) };
}

const PARENTS = {
  kontakte: "/kontakte",
  produkte: "/produkte",
} as const satisfies Record<string, Route>;

export async function CatalogPage({
  page,
  parent,
  permission,
  title,
  description,
  body = true,
  children,
}: {
  page: PageKey;
  parent?: keyof typeof PARENTS;
  permission: Permission;
  /** Overrides the page title (detail pages render their own header). */
  title?: string;
  description?: string;
  /** Wrap children in PageBody (lists bring their own layout). */
  body?: boolean;
  children: React.ReactNode;
}) {
  const t = await getTranslations("pages");
  const tNav = await getTranslations("nav");
  const breadcrumbs: Breadcrumb[] = [];
  if (parent) breadcrumbs.push({ label: tNav(`items.${parent}`), href: PARENTS[parent] });
  breadcrumbs.push({ label: title ?? t(`${page}.title`) });
  return (
    <>
      <PageHeader
        title={title ?? t(`${page}.title`)}
        description={description ?? t(`${page}.description`)}
        breadcrumbs={breadcrumbs}
      />
      <RoleGate permission={permission}>{body ? <PageBody>{children}</PageBody> : children}</RoleGate>
    </>
  );
}
