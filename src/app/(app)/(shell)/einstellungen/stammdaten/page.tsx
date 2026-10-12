import { MasterDataAdmin } from "@/components/settings/master-data-admin";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("stammdaten");

export default function Page() {
  return (
    <SettingsPage item="stammdaten">
      <MasterDataAdmin />
    </SettingsPage>
  );
}
