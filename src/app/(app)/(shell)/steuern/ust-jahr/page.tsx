import { TaxPage, taxMetadata } from "@/components/tax/tax-page";
import { UstAnnualWorkspace } from "@/components/tax/ust-annual-workspace";
import { requireRole } from "@/lib/auth-server";

export const generateMetadata = () => taxMetadata("ustJahr");
export const dynamic = "force-dynamic";

/** /steuern/ust-jahr (F08 §6, TAX-023): USt-Jahreserklärung worksheet, reconciliation, Mein ELSTER steps. */
export default function Page() {
  return (
    <TaxPage page="ustJahr">
      <Content />
    </TaxPage>
  );
}

async function Content() {
  await requireRole("tax.read");
  return <UstAnnualWorkspace />;
}
