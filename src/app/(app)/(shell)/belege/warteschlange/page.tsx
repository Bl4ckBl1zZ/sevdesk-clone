import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { VoucherQueue } from "@/components/vouchers/voucher-queue";

export const generateMetadata = () => catalogMetadata("belegeWarteschlange");

export default function Page() {
  return (
    <CatalogPage page="belegeWarteschlange" parent="belege" permission="vouchers.write" body={false}>
      <VoucherQueue />
    </CatalogPage>
  );
}
