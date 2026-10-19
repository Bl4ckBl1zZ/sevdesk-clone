import { Suspense } from "react";
import { RoleGate } from "@/components/auth/role-gate";
import { BankCallback } from "@/components/banking/bank-callback";
import { SettingsPage } from "@/components/settings/settings-page";

export const metadata = { title: "Bankverbindung wird hergestellt" };
export const dynamic = "force-dynamic";

/**
 * /einstellungen/bank/callback (F07 BNK-102/103/115): the redirect target of the Enable Banking consent
 * (`https://app.<BASE_DOMAIN>/einstellungen/bank/callback`, whitelisted in the application). Owner only.
 */
export default function Page() {
  return (
    <SettingsPage
      item="bank"
      sub={{ title: "Bankverbindung", description: "Rückkehr von der Bank: Zustimmung prüfen und Umsätze abrufen" }}
    >
      <RoleGate permission="bankFeed.consent">
        <Suspense fallback={<div className="h-48" aria-busy="true" />}>
          <BankCallback />
        </Suspense>
      </RoleGate>
    </SettingsPage>
  );
}
