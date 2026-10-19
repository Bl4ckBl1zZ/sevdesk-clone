import { PlaceholderPage, placeholderMetadata } from "@/components/layout/placeholder-page";
import { TaxScopeNotice } from "@/components/tax/tax-scope-notice";

export const generateMetadata = () => placeholderMetadata("ustva");

export default function Page() {
  return <PlaceholderPage page="ustva" notice={<TaxScopeNotice page="other" />} />;
}
