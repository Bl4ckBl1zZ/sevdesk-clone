import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { RecurringVouchers } from "@/components/vouchers/recurring-vouchers";

export const generateMetadata = () => catalogMetadata("belegeWiederkehrend");

export default function Page() {
  return (
    <CatalogPage page="belegeWiederkehrend" parent="belege" permission="vouchers.read" body={false}>
      <RecurringVouchers />
    </CatalogPage>
  );
}
