import { RoleGate } from "@/components/auth/role-gate";
import { BankConnectionPanel } from "@/components/banking/bank-connection";
import { SettingsPage } from "@/components/settings/settings-page";

export const metadata = { title: "Bankanbindung" };
export const dynamic = "force-dynamic";

/** /einstellungen/bank/verbindung (F01 SET-049/049a, F07 BNK-101…117, 04 §4.13): Enable Banking connection. */
export default function Page() {
  return (
    <SettingsPage
      item="bank"
      sub={{
        title: "Bankanbindung",
        description: "Enable Banking (Revolut Business): Einrichtung, Zustimmung und Abrufe",
      }}
    >
      <RoleGate permission="banking.read">
        <BankConnectionPanel />
      </RoleGate>
    </SettingsPage>
  );
}
