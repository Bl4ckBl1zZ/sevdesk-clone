import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { NewInvoice } from "@/components/invoices/new-invoice";

export const generateMetadata = () => catalogMetadata("rechnungenNeu");

/** „Neue Rechnung“; `?typ=proforma` opens the editor for a Proforma-Rechnung (QUO-12), `?kontakt=` the customer. */
export default async function Page({ searchParams }: { searchParams: Promise<{ kontakt?: string; typ?: string }> }) {
  const { kontakt, typ } = await searchParams;
  const proforma = typ === "proforma";
  return (
    <CatalogPage page={proforma ? "proformaNeu" : "rechnungenNeu"} parent="rechnungen" permission="documents.write">
      <NewInvoice type={proforma ? "proforma" : "invoice"} {...(kontakt ? { contactId: kontakt } : {})} />
    </CatalogPage>
  );
}
