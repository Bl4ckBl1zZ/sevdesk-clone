import { RoleGate } from "@/components/auth/role-gate";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";
import { ZugriffskonzeptChapter } from "@/components/settings/verfahrensdoku";

export const generateMetadata = () => settingsMetadata("verfahrensdokumentation");

/** Verfahrensdokumentation (F12 §5): P0 generates the chapter „Zugriffskonzept“ (SET-047); further chapters follow. */
export default function Page() {
  return (
    <SettingsPage item="verfahrensdokumentation">
      <RoleGate permission="members.read">
        <ZugriffskonzeptChapter />
      </RoleGate>
    </SettingsPage>
  );
}
