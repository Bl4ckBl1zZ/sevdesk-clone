import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { ContactForm } from "@/components/contacts/contact-form";

export const generateMetadata = () => catalogMetadata("kontakteNeu");

export default async function Page({ searchParams }: { searchParams: Promise<{ parent?: string }> }) {
  const { parent } = await searchParams;
  return (
    <CatalogPage page="kontakteNeu" parent="kontakte" permission="contacts.write">
      <ContactForm defaultParentId={parent} />
    </CatalogPage>
  );
}
