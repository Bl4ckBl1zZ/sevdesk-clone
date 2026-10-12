import { SettingsPlaceholder, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("datenschutz");

export default function Page() {
  return <SettingsPlaceholder item="datenschutz" />;
}
