import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { DatevCard } from "@/components/exports/datev-card";
import { FullExportCard } from "@/components/exports/full-export-card";
import { GdpduCard } from "@/components/exports/gdpdu-card";
import { JobsPage } from "@/components/exports/jobs-page";

export const generateMetadata = () => catalogMetadata("export");

/**
 * F09 EXP-026: export jobs (progress, cancel, 30-day download); EXP-023 Vollexport (owner); EXP-017 GDPdU/Z3
 * (owner/bookkeeper create; auditor downloads the packages of the granted years, AUD-023); EXP-001…016 DATEV
 * (P3, low priority; shown once the DATEV keys exist).
 */
export default function Page() {
  return (
    <CatalogPage page="export" permission="documents.export">
      <div className="flex flex-col gap-6">
        <FullExportCard />
        <GdpduCard />
        <DatevCard />
        <JobsPage />
      </div>
    </CatalogPage>
  );
}
