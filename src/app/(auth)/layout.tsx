import { ThemeToggle } from "@/components/theme-toggle";

/** Auth pages: centred, single column, no app shell (04-ui-ux §4.9). */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex justify-end p-3">
        <ThemeToggle />
      </div>
      <main id="main" className="flex flex-1 items-start justify-center px-4 pb-12 sm:items-center">
        {children}
      </main>
    </div>
  );
}
