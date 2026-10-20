import { Suspense } from "react";
import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { ForecastWorkspace } from "@/components/reports/forecast-workspace";

export const generateMetadata = () => catalogMetadata("liquiditaet");

/** /auswertungen/liquiditaet (F08 §6, RPT-012): 90-day cash-flow forecast „erwartet“ / „vorsichtig“. */
export default function Page() {
  return (
    <CatalogPage page="liquiditaet" permission="reports.read">
      <Suspense fallback={null}>
        <ForecastWorkspace />
      </Suspense>
    </CatalogPage>
  );
}
