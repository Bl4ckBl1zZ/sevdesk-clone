import { SettingsPlaceholder, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("import");

export default function Page() {
  return <SettingsPlaceholder item="import" />;
}
