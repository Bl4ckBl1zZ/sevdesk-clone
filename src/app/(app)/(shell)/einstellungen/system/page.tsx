import { RoleGate } from "@/components/auth/role-gate";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";
import { HealthPanel, SystemOverviewPanel, VersionsCard } from "@/components/settings/system-panels";
import { requireRole } from "@/lib/auth-server";
import { cachedHealth } from "@/server/system/health";
import { systemVersions } from "@/server/system/info";

export const generateMetadata = () => settingsMetadata("system");
export const dynamic = "force-dynamic";

/** /einstellungen/system (F01 SET-130/131/135): versions, health checks, location, access concept, restore drills. */
export default async function Page() {
  return (
    <SettingsPage item="system">
      <RoleGate permission="settings.read">
        <SystemContent />
      </RoleGate>
    </SettingsPage>
  );
}

async function SystemContent() {
  const me = await requireRole("settings.read");
  const report = await cachedHealth();
  return (
    <div className="flex flex-col gap-6">
      <SystemOverviewPanel isOwner={me.role === "owner"} />
      <HealthPanel checks={report.checks} isOwner={me.role === "owner"} />
      <VersionsCard versions={systemVersions()} einvoice={report.einvoiceTools} />
    </div>
  );
}
