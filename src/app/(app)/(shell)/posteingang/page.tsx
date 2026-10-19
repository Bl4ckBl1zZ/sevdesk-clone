import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { InboxScreen } from "@/components/inbox/inbox-screen";

export const generateMetadata = () => catalogMetadata("posteingang");

export default function Page() {
  return (
    <CatalogPage page="posteingang" parent="belege" permission="vouchers.read" body={false}>
      <InboxScreen />
    </CatalogPage>
  );
}
