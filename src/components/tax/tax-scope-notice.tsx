"use client";

import { api } from "@convex/_generated/api";
import { InfoIcon } from "lucide-react";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { EUER_BLOCKED_NOTICE } from "@/domain/tax/scope";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/**
 * F08 TAX-014 / AO-07: Bilanz companies see on every tax page that the annual accounts and the E-Bilanz are not part
 * of the software; the EÜR page also says that no EÜR is possible. EÜR companies see nothing.
 */
export function TaxScopeNotice({ page }: { page: "euer" | "other" }) {
  return (
    <ConvexGuard>
      <Inner page={page} />
    </ConvexGuard>
  );
}

function Inner({ page }: { page: "euer" | "other" }) {
  const scope = useAuthedQuery(api.settings.taxScope, {});
  if (!scope?.notice) return null;
  return (
    <div
      role="note"
      className="mb-4 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
    >
      <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="flex flex-col gap-1">
        {page === "euer" && !scope.euerAvailable && <p className="font-medium">{EUER_BLOCKED_NOTICE}</p>}
        <p>{scope.notice}</p>
      </div>
    </div>
  );
}
