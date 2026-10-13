import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { InvoicesList } from "@/components/invoices/invoices-list";

export const generateMetadata = () => catalogMetadata("auftraege");

export default function Page() {
  return (
    <CatalogPage page="auftraege" permission="documents.read" body={false}>
      <InvoicesList type="order_confirmation" />
    </CatalogPage>
  );
}
