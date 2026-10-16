import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { RecurringEditor } from "@/components/recurring/recurring-editor";

export const generateMetadata = () => catalogMetadata("wiederkehrendNeu");

/** Neue Vorlage (F04 §6.5). */
export default function Page() {
  return (
    <CatalogPage page="wiederkehrendNeu" parent="wiederkehrend" permission="documents.write">
      <RecurringEditor />
    </CatalogPage>
  );
}
