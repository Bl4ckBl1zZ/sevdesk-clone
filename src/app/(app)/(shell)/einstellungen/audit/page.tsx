import { AuditViewer } from "@/components/audit/audit-viewer";
import { RoleGate } from "@/components/auth/role-gate";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("audit");

/** F12 §6 `/einstellungen/audit`: audit viewer with presets, diff, chain status and export (AUD-006, AUD-008). */
export default function Page() {
  return (
    <SettingsPage item="audit">
      <RoleGate permission="audit.read">
        <AuditViewer />
      </RoleGate>
    </SettingsPage>
  );
}
