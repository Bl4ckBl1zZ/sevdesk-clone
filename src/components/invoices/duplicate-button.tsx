"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { CopyIcon } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCan, useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import { documentPath } from "@/domain/documents/doc-types";

const NOT_DUPLICABLE = new Set(["cancellation", "correction", "reminder"]);

/** F04 DOC-35 „Duplizieren“: opens the new draft; hidden for Storno, Rechnungskorrektur and Mahnung. */
export function DuplicateButton({ doc }: { doc: { _id: Id<"salesDocuments">; type: string } }) {
  const t = useTranslations("invoices.duplicate");
  const canWrite = useCan("documents.write");
  const duplicate = useMutation(api.invoices.duplicate);
  const router = useRouter();
  const run = useRun();
  if (!canWrite || NOT_DUPLICABLE.has(doc.type)) return null;
  return (
    <Button
      variant="outline"
      className="h-11 md:h-9"
      onClick={async () => {
        const r = await run(() => duplicate({ id: doc._id }), t("done"));
        if (r.ok) {
          const type = (doc.type.endsWith("_invoice") ? "invoice" : doc.type) as Parameters<typeof documentPath>[0];
          router.push(documentPath(type, r.value.id) as Route);
        }
      }}
    >
      <CopyIcon aria-hidden="true" />
      {t("label")}
    </Button>
  );
}
