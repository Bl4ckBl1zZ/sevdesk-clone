"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useShellUi } from "./shell-context";

/** `n` then `r`/`a`/`k`/`p` (04-ui-ux §5). */
export const NEW_SHORTCUTS: Record<string, Route> = {
  r: "/rechnungen/neu",
  a: "/angebote/neu",
  k: "/kontakte/neu",
  p: "/produkte/neu",
};

const CHORD_TIMEOUT_MS = 1500;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.getAttribute("role") === "combobox";
}

/** Global single-key shortcuts; ignored while typing or when a modifier is held. ⌘K and ⌘B live elsewhere. */
export function GlobalShortcuts() {
  const router = useRouter();
  const { setShortcutsOpen } = useShellUi();
  const pendingN = useRef<number | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      // A dialog is open: leave keys to it.
      if (document.querySelector("[role=dialog][data-open], [role=alertdialog][data-open]")) return;

      if (pendingN.current !== null) {
        window.clearTimeout(pendingN.current);
        pendingN.current = null;
        const href = NEW_SHORTCUTS[e.key.toLowerCase()];
        if (href) {
          e.preventDefault();
          router.push(href);
          return;
        }
      }
      if (e.key === "n") {
        pendingN.current = window.setTimeout(() => {
          pendingN.current = null;
        }, CHORD_TIMEOUT_MS);
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (e.key === "/") {
        const search = document.querySelector<HTMLInputElement>("[data-list-search]");
        if (search) {
          e.preventDefault();
          search.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, setShortcutsOpen]);

  return null;
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k) => (
        <kbd key={k} className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
          {k}
        </kbd>
      ))}
    </span>
  );
}

export function ShortcutHelpDialog() {
  const t = useTranslations("shortcuts");
  const { shortcutsOpen, setShortcutsOpen } = useShellUi();
  const rows: { keys: string[]; label: string }[] = [
    { keys: ["⌘", "K"], label: t("palette") },
    { keys: ["/"], label: t("search") },
    { keys: ["N", "R"], label: t("newInvoice") },
    { keys: ["N", "A"], label: t("newQuote") },
    { keys: ["N", "K"], label: t("newContact") },
    { keys: ["N", "P"], label: t("newProduct") },
    { keys: ["⌘", "B"], label: t("sidebar") },
    { keys: ["?"], label: t("help") },
  ];
  return (
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt>
                <Keys keys={r.keys} />
              </dt>
              <dd className="text-sm">{r.label}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
