import { RoleGate } from "@/components/auth/role-gate";
import { DunningSettings } from "@/components/dunning/dunning-settings";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("mahnwesen");

/** Einstellungen › Mahnwesen (F05 §6.6): read for everyone with `payments.read`, writes owner only. */
export default function Page() {
  return (
    <SettingsPage item="mahnwesen">
      <RoleGate permission="payments.read">
        <DunningSettings />
      </RoleGate>
    </SettingsPage>
  );
}
