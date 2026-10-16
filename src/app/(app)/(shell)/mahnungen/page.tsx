import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { DunningCockpit } from "@/components/dunning/dunning-cockpit";

export const generateMetadata = () => catalogMetadata("mahnungen");

/** Mahnungen cockpit (F05 §6.4). */
export default function Page() {
  return (
    <CatalogPage page="mahnungen" permission="payments.read" body={false}>
      <DunningCockpit />
    </CatalogPage>
  );
}
