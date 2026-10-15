import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { NewInvoice } from "@/components/invoices/new-invoice";

export const generateMetadata = () => catalogMetadata("angeboteNeu");

export default async function Page({ searchParams }: { searchParams: Promise<{ kontakt?: string }> }) {
  const { kontakt } = await searchParams;
  return (
    <CatalogPage page="angeboteNeu" parent="angebote" permission="documents.write">
      <NewInvoice type="quote" {...(kontakt ? { contactId: kontakt } : {})} />
    </CatalogPage>
  );
}
