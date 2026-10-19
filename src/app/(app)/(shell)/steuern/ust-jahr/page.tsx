import { PlaceholderPage, placeholderMetadata } from "@/components/layout/placeholder-page";
import { TaxScopeNotice } from "@/components/tax/tax-scope-notice";

export const generateMetadata = () => placeholderMetadata("ustJahr");

export default function Page() {
  return <PlaceholderPage page="ustJahr" notice={<TaxScopeNotice page="other" />} />;
}
