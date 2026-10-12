import { SettingsBackLink, SettingsNav } from "@/components/settings/settings-nav";

/** Settings: grouped navigation on the left on wide containers, a list page on phones (04-ui-ux §4.8). */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="@5xl/main:grid @5xl/main:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="hidden border-r @5xl/main:block">
        <SettingsNav />
      </aside>
      <div className="min-w-0">
        <SettingsBackLink />
        {children}
      </div>
    </div>
  );
}
