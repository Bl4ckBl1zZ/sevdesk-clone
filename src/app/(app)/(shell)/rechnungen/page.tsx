import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { InvoicesList } from "@/components/invoices/invoices-list";

export const generateMetadata = () => catalogMetadata("rechnungen");

export default function Page() {
  return (
    <CatalogPage page="rechnungen" permission="documents.read" body={false}>
      <InvoicesList />
    </CatalogPage>
  );
}
