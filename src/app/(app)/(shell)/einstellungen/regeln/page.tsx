import { SettingsPlaceholder, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("regeln");

export default function Page() {
  return <SettingsPlaceholder item="regeln" />;
}
