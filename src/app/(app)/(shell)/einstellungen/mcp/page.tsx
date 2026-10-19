import { SecretScreenLog } from "@/components/audit/audit-watchers";
import { RoleGate } from "@/components/auth/role-gate";
import { McpConnect } from "@/components/settings/mcp-connect";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("mcp");

export default function Page() {
  return (
    <SettingsPage item="mcp">
      <RoleGate permission="apiKeys.read">
        <McpConnect />
        <SecretScreenLog screen="MCP-Schlüssel" />
      </RoleGate>
    </SettingsPage>
  );
}
