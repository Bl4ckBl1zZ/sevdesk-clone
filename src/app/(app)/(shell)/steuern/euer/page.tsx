import { EuerWorkspace } from "@/components/tax/euer-workspace";
import { TaxPage, taxMetadata } from "@/components/tax/tax-page";
import { canDo } from "@/domain/access/permissions";
import { requireRole } from "@/lib/auth-server";

export const generateMetadata = () => taxMetadata("euer");
export const dynamic = "force-dynamic";

/** /steuern/euer (F08 §6, §4.7a; TAX-015, TAX-016, TAX-022, AO-02): Anlage EÜR, AVEÜR, Mein ELSTER steps, submission. */
export default function Page() {
  return (
    <TaxPage page="euer">
      <Content />
    </TaxPage>
  );
}

async function Content() {
  const me = await requireRole("tax.read");
  return <EuerWorkspace canSubmit={canDo(me.role, "tax.submit")} />;
}
