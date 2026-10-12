import { RoleGate } from "@/components/auth/role-gate";
import { MembersPanel } from "@/components/settings/members-panel";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("mitglieder");

export default function Page() {
  return (
    <SettingsPage item="mitglieder">
      <RoleGate permission="members.read">
        <MembersPanel />
      </RoleGate>
    </SettingsPage>
  );
}
