import { SecretScreenLog } from "@/components/audit/audit-watchers";
import { RoleGate } from "@/components/auth/role-gate";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";
import { WebhooksAdmin } from "@/components/settings/webhooks-admin";

export const generateMetadata = () => settingsMetadata("webhooks");

export default function Page() {
  return (
    <SettingsPage item="webhooks">
      <RoleGate permission="webhooks.read">
        <WebhooksAdmin />
        <SecretScreenLog screen="Webhooks" />
      </RoleGate>
    </SettingsPage>
  );
}
