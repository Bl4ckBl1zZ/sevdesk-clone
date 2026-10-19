import { TaxPage, taxMetadata } from "@/components/tax/tax-page";
import { ZmWorkspace } from "@/components/tax/zm-workspace";
import { canDo } from "@/domain/access/permissions";
import { requireRole } from "@/lib/auth-server";

export const generateMetadata = () => taxMetadata("zm");
export const dynamic = "force-dynamic";

/** /steuern/zm (F08 §6; TAX-009, TAX-020, TAX-021): ZM rows, reconciliation, Mein ELSTER steps, CSV, submission. */
export default function Page() {
  return (
    <TaxPage page="zm">
      <Content />
    </TaxPage>
  );
}

async function Content() {
  const me = await requireRole("tax.read");
  return <ZmWorkspace canSubmit={canDo(me.role, "tax.submit")} />;
}
