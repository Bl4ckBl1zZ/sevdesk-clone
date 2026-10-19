import { RoleGate } from "@/components/auth/role-gate";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";
import { BankdatenChapter, ScanningChapter, ZugriffskonzeptChapter } from "@/components/settings/verfahrensdoku";
import { VerfahrensdokuGenerator } from "@/components/settings/verfahrensdoku-generator";

export const generateMetadata = () => settingsMetadata("verfahrensdokumentation");

/**
 * Verfahrensdokumentation (F12 AUD-024/025, §4.6): all chapters with status, owner inputs, release and versions;
 * below, the detailed chapters „Zugriffskonzept“ (SET-047), „Ersetzendes Scannen“ (F06 VOU-125) and „Bankdaten“
 * (F07 BNK-116). EDGE_MODE adds the Cloudflare tunnel to chapter 2/15.
 */
export default function Page() {
  return (
    <SettingsPage item="verfahrensdokumentation">
      <RoleGate permission="settings.read">
        <div className="flex flex-col gap-6">
          <VerfahrensdokuGenerator publicEdge={process.env.EDGE_MODE === "public"} />
          <RoleGate permission="members.read">
            <ZugriffskonzeptChapter />
          </RoleGate>
        </div>
      </RoleGate>
      <RoleGate permission="members.read">
        <ScanningChapter />
      </RoleGate>
      <RoleGate permission="banking.read">
        <BankdatenChapter />
      </RoleGate>
    </SettingsPage>
  );
}
