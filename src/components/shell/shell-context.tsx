"use client";

import * as React from "react";

interface ShellUi {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
}

const ShellUiContext = React.createContext<ShellUi | null>(null);

/** UI state shared by the top bar, tab bar, command palette and keyboard shortcuts. */
export function ShellUiProvider({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const value = React.useMemo(
    () => ({ paletteOpen, setPaletteOpen, shortcutsOpen, setShortcutsOpen, createOpen, setCreateOpen }),
    [paletteOpen, shortcutsOpen, createOpen],
  );
  return <ShellUiContext.Provider value={value}>{children}</ShellUiContext.Provider>;
}

export function useShellUi(): ShellUi {
  const ctx = React.useContext(ShellUiContext);
  if (!ctx) throw new Error("useShellUi must be used within ShellUiProvider");
  return ctx;
}
