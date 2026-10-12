import { SettingsPlaceholder, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("api");

export default function Page() {
  return <SettingsPlaceholder item="api" />;
}
