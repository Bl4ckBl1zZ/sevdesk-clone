import { SecretScreenLog } from "@/components/audit/audit-watchers";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";
import { IntegrationsPanel } from "@/components/settings/status-panels";

export const generateMetadata = () => settingsMetadata("integrationen");

export default function Page() {
  return (
    <SettingsPage item="integrationen">
      <IntegrationsPanel />
      <SecretScreenLog screen="Integrationen" />
    </SettingsPage>
  );
}
