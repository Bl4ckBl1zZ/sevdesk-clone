import { RoleGate } from "@/components/auth/role-gate";
import { RulesAdmin } from "@/components/settings/rules-admin";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("regeln");

/** /einstellungen/regeln (F01 SET-120…123): shipped rule tables, the row effective today and owner overrides. */
export default function Page() {
  return (
    <SettingsPage item="regeln">
      <RoleGate permission="settings.read">
        <RulesAdmin />
      </RoleGate>
    </SettingsPage>
  );
}
