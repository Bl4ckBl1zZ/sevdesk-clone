"use client";

import { api } from "@convex/_generated/api";
import { useConvex, useMutation } from "convex/react";
import { ImportWizard } from "@/components/catalog/import-wizard";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { autoMapProductHeaders, PRODUCT_IMPORT_FIELD_LABELS, PRODUCT_IMPORT_FIELDS } from "@/domain/products/csv-io";

/** PRD-080: products CSV import (rows mapped and validated on the server with the same domain parser). */
export function ProductImport() {
  return (
    <ConvexGuard fallback={<div className="h-64" aria-busy="true" />}>
      <ProductImportInner />
    </ConvexGuard>
  );
}

function ProductImportInner() {
  const convex = useConvex();
  const commit = useMutation(api.products.importCommit);
  return (
    <ImportWizard
      namespace="products.import"
      fields={PRODUCT_IMPORT_FIELDS}
      fieldLabels={PRODUCT_IMPORT_FIELD_LABELS}
      autoMap={autoMapProductHeaders}
      checkMapping={(m) => (m.includes("name") ? null : "Bitte mindestens „Name“ zuordnen.")}
      preview={(rows, mapping) => convex.query(api.products.importPreview, { rows, mapping })}
      commit={(rows, mapping, mode) => commit({ rows, mapping, mode })}
    />
  );
}
