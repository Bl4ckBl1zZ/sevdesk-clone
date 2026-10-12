import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { DuplicatesPanel } from "@/components/contacts/duplicates-panel";

export const generateMetadata = () => catalogMetadata("kontakteDuplikate");

export default function Page() {
  return (
    <CatalogPage page="kontakteDuplikate" parent="kontakte" permission="contacts.merge">
      <DuplicatesPanel />
    </CatalogPage>
  );
}
