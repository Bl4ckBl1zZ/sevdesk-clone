import { BankOverview } from "@/components/banking/bank-overview";
import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";

export const generateMetadata = () => catalogMetadata("bank");

export default function Page() {
  return (
    <CatalogPage page="bank" permission="banking.read" body={false}>
      <BankOverview />
    </CatalogPage>
  );
}
