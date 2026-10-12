import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { ConvexClientProvider } from "@/components/convex/convex-provider";
import { HydrationMarker } from "@/components/hydration-marker";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import "./globals.css";

// next/font self-hosts the font at build time: no request to Google at runtime (DSGVO).
const inter = Inter({ subsets: ["latin", "latin-ext"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: { default: "Rechnungen", template: "%s · Rechnungen" },
  description: "Rechnungen und Buchhaltung",
  robots: { index: false, follow: false },
  applicationName: "Rechnungen",
  appleWebApp: { capable: true, title: "Rechnungen", statusBarStyle: "default" },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // bottom tab bar uses env(safe-area-inset-bottom) (04-ui-ux §3.3)
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang={locale} className={cn("font-sans antialiased", inter.variable)} suppressHydrationWarning>
      <body className="min-h-dvh bg-background text-foreground">
        <NextIntlClientProvider>
          <ConvexClientProvider>
            <ThemeProvider nonce={nonce}>
              <TooltipProvider>
                {children}
                <Toaster richColors closeButton />
                <HydrationMarker />
              </TooltipProvider>
            </ThemeProvider>
          </ConvexClientProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
