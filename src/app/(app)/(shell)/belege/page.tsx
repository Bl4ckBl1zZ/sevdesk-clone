import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { VouchersList } from "@/components/vouchers/vouchers-list";

export const generateMetadata = () => catalogMetadata("belege");

export default function Page() {
  return (
    <CatalogPage page="belege" permission="vouchers.read" body={false}>
      <VouchersList />
    </CatalogPage>
  );
}
