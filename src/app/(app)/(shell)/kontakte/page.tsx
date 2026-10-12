import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { ContactsList } from "@/components/contacts/contacts-list";

export const generateMetadata = () => catalogMetadata("kontakte");

export default function Page() {
  return (
    <CatalogPage page="kontakte" permission="contacts.read" body={false}>
      <ContactsList />
    </CatalogPage>
  );
}
