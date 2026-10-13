import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { NewInvoice } from "@/components/invoices/new-invoice";

export const generateMetadata = () => catalogMetadata("auftraegeNeu");

export default async function Page({ searchParams }: { searchParams: Promise<{ kontakt?: string }> }) {
  const { kontakt } = await searchParams;
  return (
    <CatalogPage page="auftraegeNeu" parent="auftraege" permission="documents.write">
      <NewInvoice type="order_confirmation" {...(kontakt ? { contactId: kontakt } : {})} />
    </CatalogPage>
  );
}
