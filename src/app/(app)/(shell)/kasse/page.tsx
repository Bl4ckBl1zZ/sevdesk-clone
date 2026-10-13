import { CashPage } from "@/components/cash/cash-page";
import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";

export const generateMetadata = () => catalogMetadata("kasse");

export default function Page() {
  return (
    <CatalogPage page="kasse" permission="banking.read" body={false}>
      <CashPage />
    </CatalogPage>
  );
}
