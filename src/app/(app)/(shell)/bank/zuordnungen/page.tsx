import { MatchingReview } from "@/components/banking/matching-review";
import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";

export const generateMetadata = () => catalogMetadata("zuordnungen");

export default function Page() {
  return (
    <CatalogPage page="zuordnungen" permission="banking.read" body={false}>
      <MatchingReview />
    </CatalogPage>
  );
}
