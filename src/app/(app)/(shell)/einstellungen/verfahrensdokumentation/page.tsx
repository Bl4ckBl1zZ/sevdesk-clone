import { RoleGate } from "@/components/auth/role-gate";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";
import { ScanningChapter, ZugriffskonzeptChapter } from "@/components/settings/verfahrensdoku";

export const generateMetadata = () => settingsMetadata("verfahrensdokumentation");

/** Verfahrensdokumentation (F12 §5): the chapters „Zugriffskonzept“ (SET-047) and „Ersetzendes Scannen“ (F06 VOU-125); further chapters follow. */
export default function Page() {
  return (
    <SettingsPage item="verfahrensdokumentation">
      <RoleGate permission="members.read">
        <ZugriffskonzeptChapter />
      </RoleGate>
      <RoleGate permission="members.read">
        <ScanningChapter />
      </RoleGate>
    </SettingsPage>
  );
}
