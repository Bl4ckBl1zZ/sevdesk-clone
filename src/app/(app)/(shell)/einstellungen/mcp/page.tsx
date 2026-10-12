import { SettingsPlaceholder, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("mcp");

export default function Page() {
  return <SettingsPlaceholder item="mcp" />;
}
