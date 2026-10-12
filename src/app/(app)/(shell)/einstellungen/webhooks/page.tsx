import { SettingsPlaceholder, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("webhooks");

export default function Page() {
  return <SettingsPlaceholder item="webhooks" />;
}
