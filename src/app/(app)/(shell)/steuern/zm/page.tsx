import { PlaceholderPage, placeholderMetadata } from "@/components/layout/placeholder-page";
import { TaxScopeNotice } from "@/components/tax/tax-scope-notice";

export const generateMetadata = () => placeholderMetadata("zm");

export default function Page() {
  return <PlaceholderPage page="zm" notice={<TaxScopeNotice page="other" />} />;
}
