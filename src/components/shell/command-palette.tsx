"use client";

import { KeyboardIcon, PlusIcon, SettingsIcon } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { NAV_SECTIONS, SECONDARY_NAV, SETTINGS_NAV } from "./nav-config";
import { useShellUi } from "./shell-context";

/** True for ⌘K (macOS) / Ctrl+K (others), 04-ui-ux §5. */
export function isPaletteShortcut(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

const CREATE_ACTIONS = [
  { key: "newInvoice", href: "/rechnungen/neu", shortcut: "N R" },
  { key: "newQuote", href: "/angebote/neu", shortcut: "N A" },
  { key: "newContact", href: "/kontakte/neu", shortcut: "N K" },
  { key: "newProduct", href: "/produkte/neu", shortcut: "N P" },
] as const satisfies readonly { key: string; href: Route; shortcut: string }[];

/**
 * Command palette stub (04-ui-ux §5): navigation to every page and settings page plus "Neu" actions.
 * Global search over documents/contacts/products follows once the Convex search queries exist.
 */
export function CommandPalette() {
  const t = useTranslations();
  const router = useRouter();
  const { paletteOpen, setPaletteOpen, setShortcutsOpen } = useShellUi();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isPaletteShortcut(e)) {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paletteOpen, setPaletteOpen]);

  const go = (href: Route) => {
    setPaletteOpen(false);
    router.push(href);
  };

  return (
    <CommandDialog
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      title={t("commandPalette.title")}
      description={t("commandPalette.description")}
    >
      <Command>
        <CommandInput placeholder={t("commandPalette.placeholder")} aria-label={t("commandPalette.placeholder")} />
        <CommandList label={t("commandPalette.groupPages")}>
          <CommandEmpty>{t("commandPalette.empty")}</CommandEmpty>
          <CommandGroup heading={t("commandPalette.groupActions")}>
            {CREATE_ACTIONS.map((a) => (
              <CommandItem key={a.key} value={t(`commandPalette.actions.${a.key}`)} onSelect={() => go(a.href)}>
                <PlusIcon aria-hidden="true" />
                {t(`commandPalette.actions.${a.key}`)}
                <CommandShortcut>{a.shortcut}</CommandShortcut>
              </CommandItem>
            ))}
            <CommandItem
              value={t("commandPalette.actions.shortcuts")}
              onSelect={() => {
                setPaletteOpen(false);
                setShortcutsOpen(true);
              }}
            >
              <KeyboardIcon aria-hidden="true" />
              {t("commandPalette.actions.shortcuts")}
              <CommandShortcut>?</CommandShortcut>
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading={t("commandPalette.groupPages")}>
            {[...NAV_SECTIONS.flatMap((s) => s.items), ...SECONDARY_NAV].map((item) => {
              const Icon = item.icon;
              const label = t(`nav.items.${item.key}`);
              return (
                <CommandItem key={item.key} value={`${label} ${item.href}`} onSelect={() => go(item.href)}>
                  <Icon aria-hidden="true" />
                  {label}
                </CommandItem>
              );
            })}
          </CommandGroup>
          <CommandGroup heading={t("commandPalette.groupSettings")}>
            {SETTINGS_NAV.flatMap((g) => g.items).map((item) => {
              const label = t(`settings.items.${item.key}`);
              return (
                <CommandItem
                  key={item.key}
                  value={`${t("nav.items.einstellungen")} ${label}`}
                  onSelect={() => go(item.href)}
                >
                  <SettingsIcon aria-hidden="true" />
                  {label}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
