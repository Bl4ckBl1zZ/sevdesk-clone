import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";
import { TextTemplatesAdmin } from "@/components/settings/text-templates-admin";

export const generateMetadata = () => settingsMetadata("textvorlagen");

export default function Page() {
  return (
    <SettingsPage item="textvorlagen">
      <TextTemplatesAdmin />
    </SettingsPage>
  );
}
