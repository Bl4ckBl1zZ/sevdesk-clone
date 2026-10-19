import { RoleGate } from "@/components/auth/role-gate";
import { NumberRegister } from "@/components/settings/number-register";
import { SettingsPage } from "@/components/settings/settings-page";

export const metadata = { title: "Nummernregister" };

/** /einstellungen/nummernkreise/register (F01 SET-063): issued numbers, status, document links and gap report. */
export default async function Page({ searchParams }: { searchParams: Promise<{ range?: string; period?: string }> }) {
  const { range, period } = await searchParams;
  return (
    <SettingsPage
      item="nummernkreise"
      sub={{ title: "Nummernregister", description: "Vergebene Nummern und Lückenbericht" }}
    >
      <RoleGate permission="settings.read">
        <NumberRegister {...(range ? { initialRange: range } : {})} {...(period ? { initialPeriod: period } : {})} />
      </RoleGate>
    </SettingsPage>
  );
}
