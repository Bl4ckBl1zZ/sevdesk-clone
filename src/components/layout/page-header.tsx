import type { Route } from "next";
import Link from "next/link";
import type * as React from "react";
import { cn } from "@/lib/utils";

export interface Breadcrumb {
  label: string;
  href?: Route;
}

/**
 * Page header (04-ui-ux §1.2, §4.1): title, optional breadcrumb and the one primary action. The action area is
 * sticky in the header on desktop and becomes a sticky bottom action bar (above the tab bar) on phones.
 */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  className,
}: {
  title: string;
  description?: string;
  breadcrumbs?: Breadcrumb[];
  actions?: React.ReactNode;
  className?: string;
}) {
  // The blur is desktop-only (where the header is sticky): `backdrop-filter` makes the header the containing block
  // of the `position: fixed` phone action bar below, which then sat at the top of the page instead of the bottom.
  return (
    <header
      data-slot="page-header"
      className={cn(
        "flex flex-col gap-3 border-b bg-background/95 px-4 py-4 md:backdrop-blur md:supports-backdrop-filter:bg-background/80 @3xl/main:flex-row @3xl/main:items-end @3xl/main:justify-between @3xl/main:px-6 md:sticky md:top-14 md:z-10",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Brotkrümelnavigation" className="hidden text-muted-foreground text-sm md:block">
            <ol className="flex flex-wrap items-center gap-1.5">
              {breadcrumbs.map((crumb, i) => (
                <li key={`${crumb.label}|${crumb.href ?? ""}`} className="flex items-center gap-1.5">
                  {i > 0 && <span aria-hidden="true">›</span>}
                  {crumb.href ? (
                    <Link href={crumb.href} className="underline-offset-4 hover:text-foreground hover:underline">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span>{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        <h1 id="page-title" tabIndex={-1} className="truncate font-semibold text-2xl tracking-tight outline-none">
          {title}
        </h1>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {actions && (
        <div
          data-slot="page-actions"
          className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 flex gap-2 border-t bg-background p-3 *:flex-1 md:static md:z-auto md:border-0 md:bg-transparent md:p-0 md:*:flex-none"
        >
          {actions}
        </div>
      )}
    </header>
  );
}
