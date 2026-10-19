import Link from "next/link";
import { NumberRangesAdmin } from "@/components/settings/number-ranges-admin";
import { NumberRangesSettings, SaveButton } from "@/components/settings/settings-forms";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("nummernkreise");

export default async function Page() {
  return (
    <SettingsPage item="nummernkreise" actions={<SaveButton />}>
      <div className="flex flex-col gap-6">
        <NumberRangesSettings />
        <NumberRangesAdmin />
        <Link href="/einstellungen/nummernkreise/register" className="text-sm underline">
          Nummernregister und Lückenbericht
        </Link>
      </div>
    </SettingsPage>
  );
}
