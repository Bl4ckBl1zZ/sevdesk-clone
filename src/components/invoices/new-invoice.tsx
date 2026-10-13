"use client";

import { ConvexGuard } from "@/components/convex/convex-provider";
import type { DraftType } from "@/domain/documents/doc-types";
import { InvoiceEditor } from "./invoice-editor";

/** „Neue Rechnung / Neues Angebot / …“ (F04 §6.2); `?kontakt=` preselects the customer (from the contact page). */
export function NewInvoice({ contactId, type = "invoice" }: { contactId?: string; type?: DraftType }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <InvoiceEditor type={type} {...(contactId ? { presetContactId: contactId } : {})} />
    </ConvexGuard>
  );
}
