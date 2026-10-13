import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { InvoicesList } from "@/components/invoices/invoices-list";

export const generateMetadata = () => catalogMetadata("angebote");

export default function Page() {
  return (
    <CatalogPage page="angebote" permission="documents.read" body={false}>
      <InvoicesList type="quote" />
    </CatalogPage>
  );
}
