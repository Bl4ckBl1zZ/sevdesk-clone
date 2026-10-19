import { RoleGate } from "@/components/auth/role-gate";
import { PrivacyPage } from "@/components/settings/privacy-page";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("datenschutz");

/** F12 §6 `/einstellungen/datenschutz` (PRV-001, PRV-015, PRV-016, SET-114). EDGE_MODE adds the Cloudflare tunnel. */
export default function Page() {
  return (
    <SettingsPage item="datenschutz">
      <RoleGate permission="settings.read">
        <PrivacyPage publicEdge={process.env.EDGE_MODE === "public"} />
      </RoleGate>
    </SettingsPage>
  );
}
