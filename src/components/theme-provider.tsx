"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type * as React from "react";

/**
 * Light / dark / system theme (04-ui-ux §2). Adds the `dark` class on <html>. `nonce` is the per-request CSP nonce
 * from proxy.ts (`x-nonce`) so the inline theme script is allowed by `script-src 'nonce-…'`.
 */
export function ThemeProvider({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...(nonce ? { nonce } : {})}
    >
      {children}
    </NextThemesProvider>
  );
}
