import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { OpenItemsPage } from "@/components/payments/open-items-page";

export const generateMetadata = () => catalogMetadata("offenePosten");

export default function Page() {
  return (
    <CatalogPage page="offenePosten" permission="payments.read" body={false}>
      <OpenItemsPage />
    </CatalogPage>
  );
}
