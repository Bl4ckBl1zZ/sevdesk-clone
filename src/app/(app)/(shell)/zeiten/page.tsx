import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { TimePage } from "@/components/time/time-entries";

export const generateMetadata = () => catalogMetadata("zeiten");

export default function Page() {
  return (
    <CatalogPage page="zeiten" permission="projects.read" body={false}>
      <TimePage />
    </CatalogPage>
  );
}
