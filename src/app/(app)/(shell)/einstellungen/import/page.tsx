import { RoleGate } from "@/components/auth/role-gate";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";
import { SevdeskImport } from "@/components/settings/sevdesk-import";
import { canDo } from "@/domain/access/permissions";
import { requireRole } from "@/lib/auth-server";

export const generateMetadata = () => settingsMetadata("import");
export const dynamic = "force-dynamic";

/** /einstellungen/import (F09 IMP-009/016/017/019/023): sevdesk file-export import — upload, preview, commit. */
export default async function Page() {
  return (
    <SettingsPage item="import">
      <RoleGate permission="imports.read">
        <ImportContent />
      </RoleGate>
    </SettingsPage>
  );
}

async function ImportContent() {
  const me = await requireRole("imports.read");
  return <SevdeskImport canRun={canDo(me.role, "imports.run")} canCommit={canDo(me.role, "imports.commit")} />;
}
