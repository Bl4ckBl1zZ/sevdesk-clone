import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { RecurringList } from "@/components/recurring/recurring-list";

export const generateMetadata = () => catalogMetadata("wiederkehrend");

/** „Wiederkehrende Rechnungen“ (F04 §6.1): Aktiv · Pausiert · Beendet. */
export default function Page() {
  return (
    <CatalogPage page="wiederkehrend" parent="rechnungen" permission="documents.read" body={false}>
      <RecurringList />
    </CatalogPage>
  );
}
