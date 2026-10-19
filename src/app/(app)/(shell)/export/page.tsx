import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { JobsPage } from "@/components/exports/jobs-page";

export const generateMetadata = () => catalogMetadata("export");

/** F09 EXP-026: export jobs (progress, cancel, 30-day download). DATEV/GDPdU/full export are later phases. */
export default function Page() {
  return (
    <CatalogPage page="export" permission="documents.export">
      <JobsPage />
    </CatalogPage>
  );
}
