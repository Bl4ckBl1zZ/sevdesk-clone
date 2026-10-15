import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { NewInvoice } from "@/components/invoices/new-invoice";

export const generateMetadata = () => catalogMetadata("lieferscheineNeu");

export default async function Page({ searchParams }: { searchParams: Promise<{ kontakt?: string }> }) {
  const { kontakt } = await searchParams;
  return (
    <CatalogPage page="lieferscheineNeu" parent="lieferscheine" permission="documents.write">
      <NewInvoice type="delivery_note" {...(kontakt ? { contactId: kontakt } : {})} />
    </CatalogPage>
  );
}
