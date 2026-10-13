import { RoleGate } from "@/components/auth/role-gate";
import { ApiKeysAdmin } from "@/components/settings/api-keys-admin";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("api");

export default function Page() {
  return (
    <SettingsPage item="api">
      <RoleGate permission="apiKeys.read">
        <ApiKeysAdmin />
      </RoleGate>
    </SettingsPage>
  );
}
