import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { ContactImport } from "@/components/contacts/contact-import";

export const generateMetadata = () => catalogMetadata("kontakteImport");

export default function Page() {
  return (
    <CatalogPage page="kontakteImport" parent="kontakte" permission="contacts.write">
      <ContactImport />
    </CatalogPage>
  );
}
