import { RoleGate } from "@/components/auth/role-gate";
import { NotificationSettings } from "@/components/notifications/notification-settings";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("benachrichtigungen");

/** F12 §6 `/einstellungen/benachrichtigungen`: channel matrix, e-mail address, ntfy (NTF-002…004). */
export default function Page() {
  return (
    <SettingsPage item="benachrichtigungen">
      <RoleGate permission="settings.read">
        <NotificationSettings />
      </RoleGate>
    </SettingsPage>
  );
}
