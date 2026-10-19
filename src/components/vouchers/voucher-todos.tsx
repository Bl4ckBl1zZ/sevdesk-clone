"use client";

import { api } from "@convex/_generated/api";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCan } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/** VOU-111 / GOBD-04 dashboard to-do: drafts older than 10 days („Unbearbeitet > 10 Tage“). */
export function VoucherTodosWidget() {
  return (
    <ConvexGuard fallback={null}>
      <VoucherTodosInner />
    </ConvexGuard>
  );
}

function VoucherTodosInner() {
  const t = useTranslations("vouchers.todos");
  const canRead = useCan("vouchers.read");
  const unbooked = useAuthedQuery(api.vouchers.unbooked, {}, canRead);
  if (!unbooked || unbooked.length === 0) return null;
  return (
    <p className="text-sm" data-testid="voucher-todos">
      <Link href={"/belege?status=unbooked" as Route} className="underline-offset-4 hover:underline">
        {t("unbooked", { count: unbooked.length })}
      </Link>
    </p>
  );
}
