import type { LucideIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import type * as React from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Empty state (04-ui-ux §4.1): an illustration, one sentence and one primary action. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  children,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; href: Route };
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      data-slot="empty-state"
      aria-label={title}
      className={cn(
        "mx-auto flex max-w-md flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-12 text-center",
        className,
      )}
    >
      {Icon && (
        <div className="flex size-14 items-center justify-center rounded-full bg-muted" aria-hidden="true">
          <Icon className="size-7 text-muted-foreground" />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <p className="font-medium">{title}</p>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {action && (
        <Link href={action.href} className={cn(buttonVariants(), "min-h-11 md:min-h-9")}>
          {action.label}
        </Link>
      )}
      {children}
    </section>
  );
}
