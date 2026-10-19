import { PlaceholderPage, placeholderMetadata } from "@/components/layout/placeholder-page";
import { TaxScopeNotice } from "@/components/tax/tax-scope-notice";

export const generateMetadata = () => placeholderMetadata("ruecklage");

export default function Page() {
  return <PlaceholderPage page="ruecklage" notice={<TaxScopeNotice page="other" />} />;
}
