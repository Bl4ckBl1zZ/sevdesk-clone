import { PlaceholderPage, placeholderMetadata } from "@/components/layout/placeholder-page";
import { TaxScopeNotice } from "@/components/tax/tax-scope-notice";

export const generateMetadata = () => placeholderMetadata("euer");

export default function Page() {
  return <PlaceholderPage page="euer" notice={<TaxScopeNotice page="euer" />} />;
}
