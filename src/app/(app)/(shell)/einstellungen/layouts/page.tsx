import { LayoutsAdmin } from "@/components/settings/layouts-admin";
import { LayoutSettings, SaveButton } from "@/components/settings/settings-forms";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("layouts");

export default async function Page() {
  return (
    <SettingsPage item="layouts" actions={<SaveButton />}>
      <div className="flex flex-col gap-6">
        <LayoutSettings />
        <LayoutsAdmin />
      </div>
    </SettingsPage>
  );
}
