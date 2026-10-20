import { TaxPage, taxMetadata } from "@/components/tax/tax-page";
import { UstvaWorkspace } from "@/components/tax/ustva-workspace";
import { canDo } from "@/domain/access/permissions";
import { requireRole } from "@/lib/auth-server";

export const generateMetadata = () => taxMetadata("ustva");
export const dynamic = "force-dynamic";

/** /steuern/ustva (F08 §6, §4.7a; TAX-001…TAX-011, TAX-019…TAX-021): Kennzahlen, Mein ELSTER steps, submission. */
export default function Page() {
  return (
    <TaxPage page="ustva">
      <Content />
    </TaxPage>
  );
}

async function Content() {
  const me = await requireRole("tax.read");
  return <UstvaWorkspace canSubmit={canDo(me.role, "tax.submit")} isOwner={canDo(me.role, "tax.settings")} />;
}
