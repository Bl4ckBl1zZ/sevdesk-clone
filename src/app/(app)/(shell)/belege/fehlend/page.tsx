import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { MissingReceipts } from "@/components/vouchers/missing-receipts";

export const generateMetadata = () => catalogMetadata("belegeFehlend");

export default function Page() {
  return (
    <CatalogPage page="belegeFehlend" parent="belege" permission="vouchers.read" body={false}>
      <MissingReceipts />
    </CatalogPage>
  );
}
