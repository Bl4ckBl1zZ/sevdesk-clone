import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SkipLink } from "@/components/shell/route-focus";
import { ThemeToggle } from "@/components/theme-toggle";

/** Focused layout for the setup wizard (no navigation; F01 SET-001 keeps the owner here until done). */
export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations();
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <header className="flex h-14 items-center gap-3 border-b px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Image src="/icon.svg" alt="" width={28} height={28} className="size-7 rounded-md" unoptimized />
          {t("app.name")}
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/" className="text-muted-foreground text-sm underline underline-offset-4 lg:hidden">
            {t("setup.resumeLater")}
          </Link>
          <ThemeToggle />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
    </div>
  );
}
