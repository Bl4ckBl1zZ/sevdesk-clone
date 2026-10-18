import type { Route } from "next";
import Link from "next/link";
import type * as React from "react";
import { cn } from "@/lib/utils";

/** Content area below the page header (container-query padding, 04-ui-ux §3.1). */
export function PageBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="page-body" className={cn("flex flex-col gap-4 p-4 @3xl/main:p-6", className)} {...props} />;
}

/**
 * List page frame (04-ui-ux §4.1): status filter + toolbar (search, filters) above the table or card list.
 * Tables switch to cards below the `@3xl/main` container width; render both variants via `table` / `cards`.
 */
export function ListLayout({
  filters,
  toolbar,
  table,
  cards,
  children,
}: {
  filters?: React.ReactNode;
  toolbar?: React.ReactNode;
  table?: React.ReactNode;
  cards?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <PageBody>
      {filters}
      {toolbar && <div className="flex flex-wrap items-center gap-2">{toolbar}</div>}
      {table && <div className="hidden @3xl/main:block">{table}</div>}
      {/* max-md:pb-16 keeps the last card clear of the phone's floating „Neu“ button (04 §1 rule 2). */}
      {/* MOT-006: cards settle slightly on press. */}
      {cards && (
        <div className="flex flex-col gap-2 *:transition-transform *:duration-150 *:active:scale-[0.99] @3xl/main:hidden max-md:pb-16">
          {cards}
        </div>
      )}
      {children}
    </PageBody>
  );
}

export interface StatusFilterOption {
  value: string;
  label: string;
  count?: number;
  href: Route;
}

/**
 * Status tabs (desktop) / horizontally scrollable chips (mobile) with counts, persisted in the URL
 * (`?status=overdue`), 04-ui-ux §4.1.
 */
export function StatusFilter({
  label,
  options,
  current,
}: {
  label: string;
  options: StatusFilterOption[];
  current: string;
}) {
  return (
    <nav aria-label={label} className="-mx-4 overflow-x-auto px-4 @3xl/main:mx-0 @3xl/main:px-0">
      <ul className="flex w-max gap-2 @3xl/main:w-auto @3xl/main:gap-1 @3xl/main:border-b">
        {options.map((o) => {
          const active = o.value === current;
          return (
            <li key={o.value}>
              <Link
                href={o.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-sm transition-[color,background-color,border-color] duration-200 @3xl/main:min-h-9 @3xl/main:rounded-none @3xl/main:border-0 @3xl/main:border-transparent @3xl/main:border-b-2",
                  active
                    ? "border-primary bg-primary text-primary-foreground @3xl/main:border-primary @3xl/main:bg-transparent @3xl/main:text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {o.label}
                {o.count !== undefined && <span className="tabular-nums">{o.count}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Detail page frame (04-ui-ux §4.2): main column (tabs, preview) and a key-facts sidebar that moves below the
 * content on narrow containers.
 */
export function DetailLayout({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <PageBody className="grid gap-6 @5xl/main:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
      {aside && <aside className="flex flex-col gap-4">{aside}</aside>}
    </PageBody>
  );
}

/** Key/value list for the detail sidebar; numbers are tabular and right-aligned (04-ui-ux §1.6). */
export function FactList({ items }: { items: { label: string; value: React.ReactNode; numeric?: boolean }[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className={cn(item.numeric && "text-right tabular-nums")}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
