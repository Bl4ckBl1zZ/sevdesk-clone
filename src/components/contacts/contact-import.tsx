"use client";

import { api } from "@convex/_generated/api";
import { useConvex, useMutation } from "convex/react";
import { type ImportRow, ImportWizard } from "@/components/catalog/import-wizard";
import { ConvexGuard } from "@/components/convex/convex-provider";
import {
  autoMapHeaders,
  CONTACT_IMPORT_FIELD_LABELS,
  CONTACT_IMPORT_FIELDS,
  type ContactImportField,
  checkMapping,
  duplicateKeysInFile,
  rowToFormValues,
} from "@/domain/contacts/csv-io";
import { emptyContactForm } from "@/domain/schemas/contacts";

/** CON-140…142: contacts CSV import (rows are mapped to the create-form shape in the browser, validated on the server). */
export function ContactImport() {
  return (
    <ConvexGuard fallback={<div className="h-64" aria-busy="true" />}>
      <ContactImportInner />
    </ConvexGuard>
  );
}

function ContactImportInner() {
  const convex = useConvex();
  const commit = useMutation(api.contacts.importCommit);
  const toValues = (rows: ImportRow[], mapping: (ContactImportField | null)[]) =>
    rows.map((r) => ({ rowNumber: r.rowNumber, values: rowToFormValues(r.cells, mapping, emptyContactForm()) }));
  return (
    <ImportWizard
      namespace="contacts.import"
      fields={CONTACT_IMPORT_FIELDS}
      fieldLabels={CONTACT_IMPORT_FIELD_LABELS}
      autoMap={autoMapHeaders}
      checkMapping={checkMapping}
      preview={async (rows, mapping, mode) => {
        const values = toValues(rows, mapping);
        // §5.7 duplicate keys inside the file are reported before the server preview.
        const dupes = duplicateKeysInFile(
          values.map((v) => ({
            rowNumber: v.rowNumber,
            number: String(v.values.contact.number ?? ""),
            vatId: String(v.values.contact.vatId ?? ""),
            email: v.values.channels.find((c) => c.type === "email")?.value ?? "",
          })),
        );
        const server = await convex.query(api.contacts.importPreview, { rows: values, mode });
        return server.map((r) =>
          dupes.has(r.rowNumber)
            ? { rowNumber: r.rowNumber, status: "error" as const, message: dupes.get(r.rowNumber) ?? null }
            : r,
        );
      }}
      commit={(rows, mapping, mode) => commit({ rows: toValues(rows, mapping), mode })}
    />
  );
}
