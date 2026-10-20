import { TaxPage, taxMetadata } from "@/components/tax/tax-page";
import { TaxReserveWorkspace } from "@/components/tax/tax-reserve-workspace";
import { canDo } from "@/domain/access/permissions";
import { requireRole } from "@/lib/auth-server";

export const generateMetadata = () => taxMetadata("ruecklage");
export const dynamic = "force-dynamic";

/** /steuern/ruecklage (F08 RPT-010/011): tax reserve estimate — „Schätzung – keine Steuerberatung“. */
export default function Page() {
  return (
    <TaxPage page="ruecklage">
      <Content />
    </TaxPage>
  );
}

async function Content() {
  const me = await requireRole("reports.read");
  return <TaxReserveWorkspace canEdit={canDo(me.role, "tax.settings")} />;
}
