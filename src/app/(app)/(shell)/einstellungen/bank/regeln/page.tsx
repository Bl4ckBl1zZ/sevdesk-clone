import { RoleGate } from "@/components/auth/role-gate";
import { MatchingRules } from "@/components/banking/matching-rules";
import { SettingsPage } from "@/components/settings/settings-page";

export const metadata = { title: "Bankregeln" };
export const dynamic = "force-dynamic";

/** /einstellungen/bank/regeln (F07 BNK-050…054, §6.4): matching rules with live preview. */
export default function Page() {
  return (
    <SettingsPage
      item="bank"
      sub={{ title: "Bankregeln", description: "Zuordnungsregeln für Bankumsätze: Bedingungen, Aktion und Vorschau" }}
    >
      <RoleGate permission="banking.read">
        <MatchingRules />
      </RoleGate>
    </SettingsPage>
  );
}
