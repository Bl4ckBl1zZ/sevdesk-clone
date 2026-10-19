import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { FullExportCard } from "@/components/exports/full-export-card";
import { JobsPage } from "@/components/exports/jobs-page";

export const generateMetadata = () => catalogMetadata("export");

/** F09 EXP-026: export jobs (progress, cancel, 30-day download); EXP-023 Vollexport (owner). DATEV/GDPdU: P3. */
export default function Page() {
  return (
    <CatalogPage page="export" permission="documents.export">
      <div className="flex flex-col gap-6">
        <FullExportCard />
        <JobsPage />
      </div>
    </CatalogPage>
  );
}
