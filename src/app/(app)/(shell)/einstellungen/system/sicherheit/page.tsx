import { api } from "@convex/_generated/api";
import { RoleGate } from "@/components/auth/role-gate";
import { SettingsPage } from "@/components/settings/settings-page";
import { SecurityPanel } from "@/components/settings/system-panels";
import { evaluateSecurity, WEB_SECRET_ENV } from "@/domain/system/security";
import { fetchAuthQuery } from "@/lib/auth-server";
import { cachedHealth } from "@/server/system/health";
import { systemVersions } from "@/server/system/info";

export const metadata = { title: "Sicherheit" };
export const dynamic = "force-dynamic";

/** /einstellungen/system/sicherheit (F12 AUD-020): setup checks with remedies (owner). */
export default function Page() {
  return (
    <SettingsPage
      item="system"
      sub={{ title: "Sicherheit", description: "Einrichtung, Zugang, Geheimnisse und Kontrollen" }}
    >
      <RoleGate permission="system.security">
        <SecurityContent />
      </RoleGate>
    </SettingsPage>
  );
}

async function SecurityContent() {
  const [inputs, report] = await Promise.all([fetchAuthQuery(api.system.securityInputs, {}), cachedHealth()]);
  const versions = systemVersions();
  const clock = report.checks.find((c) => c.id === "clock");
  const checks = evaluateSecurity(
    {
      ...inputs,
      sessionValid: true,
      webEnv: Object.fromEntries(WEB_SECRET_ENV.map((n) => [n, Boolean(process.env[n]?.trim())])) as Record<
        (typeof WEB_SECRET_ENV)[number],
        boolean
      >,
      pins: { betterAuth: versions.betterAuth, convexImage: versions.convexImage ?? inputs.convexImage },
      ...(clock ? { clock: { status: clock.status, detail: clock.detail ?? "" } } : {}),
    },
    Date.now(),
  );
  return <SecurityPanel checks={checks} />;
}
