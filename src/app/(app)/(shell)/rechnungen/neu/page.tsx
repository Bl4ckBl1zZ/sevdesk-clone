import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { NewInvoice } from "@/components/invoices/new-invoice";

export const generateMetadata = () => catalogMetadata("rechnungenNeu");

export default async function Page({ searchParams }: { searchParams: Promise<{ kontakt?: string }> }) {
  const { kontakt } = await searchParams;
  return (
    <CatalogPage page="rechnungenNeu" parent="rechnungen" permission="documents.write">
      <NewInvoice {...(kontakt ? { contactId: kontakt } : {})} />
    </CatalogPage>
  );
}
