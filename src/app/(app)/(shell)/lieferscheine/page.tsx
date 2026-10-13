import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { InvoicesList } from "@/components/invoices/invoices-list";

export const generateMetadata = () => catalogMetadata("lieferscheine");

export default function Page() {
  return (
    <CatalogPage page="lieferscheine" permission="documents.read" body={false}>
      <InvoicesList type="delivery_note" />
    </CatalogPage>
  );
}
