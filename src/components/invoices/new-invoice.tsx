"use client";

import { ConvexGuard } from "@/components/convex/convex-provider";
import { InvoiceEditor } from "./invoice-editor";

/** „Neue Rechnung“ (F04 §6.2); `?kontakt=` preselects the customer (from the contact page). */
export function NewInvoice({ contactId }: { contactId?: string }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <InvoiceEditor {...(contactId ? { presetContactId: contactId } : {})} />
    </ConvexGuard>
  );
}
