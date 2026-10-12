import { SettingsPlaceholder, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("verfahrensdokumentation");

export default function Page() {
  return <SettingsPlaceholder item="verfahrensdokumentation" />;
}
