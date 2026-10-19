import { RoleGate } from "@/components/auth/role-gate";
import { BackupsPanel } from "@/components/settings/backups-panel";
import { SettingsPage } from "@/components/settings/settings-page";

export const metadata = { title: "Datensicherungen" };

/** /einstellungen/system/backups (F12 AUD-026): backup status from the R2 backup bucket (read-only). */
export default function Page() {
  return (
    <SettingsPage item="system" sub={{ title: "Datensicherungen", description: "Stand der externen Sicherungen" }}>
      <RoleGate permission="settings.read">
        <BackupsPanel />
      </RoleGate>
    </SettingsPage>
  );
}
