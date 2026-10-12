import { SettingsPlaceholder, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("textvorlagen");

export default function Page() {
  return <SettingsPlaceholder item="textvorlagen" />;
}
