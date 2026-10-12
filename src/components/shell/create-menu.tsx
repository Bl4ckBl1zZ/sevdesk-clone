"use client";

import { ChevronDownIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CREATE_ITEMS } from "./nav-config";
import { useShellUi } from "./shell-context";

/** Desktop "+ Neu ▾" in the top bar (04-ui-ux §3.2). */
export function CreateDropdown() {
  const t = useTranslations("shell");
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button aria-label={t("newMenuLabel")} />}>
        <PlusIcon aria-hidden="true" />
        {t("new")}
        <ChevronDownIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {CREATE_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem key={item.key} onClick={() => router.push(item.href)}>
              <Icon aria-hidden="true" />
              {t(`create.${item.key}`)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Mobile "(+) Neu" bottom drawer (04-ui-ux §3.3). */
export function CreateSheet() {
  const t = useTranslations("shell");
  const { createOpen, setCreateOpen } = useShellUi();
  return (
    <Sheet open={createOpen} onOpenChange={setCreateOpen}>
      <SheetContent side="bottom" className="rounded-t-2xl pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>{t("createSheetTitle")}</SheetTitle>
          <SheetDescription>{t("createSheetDescription")}</SheetDescription>
        </SheetHeader>
        <ul className="grid grid-cols-3 gap-2 px-4 pb-4">
          {CREATE_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  onClick={() => setCreateOpen(false)}
                  className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl border p-3 text-center text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <Icon className="size-6" aria-hidden="true" />
                  {t(`create.${item.key}`)}
                </Link>
              </li>
            );
          })}
        </ul>
      </SheetContent>
    </Sheet>
  );
}
