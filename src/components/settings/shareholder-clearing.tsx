"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/**
 * F01 SET-045a „Verrechnungskonto Gesellschafter“: shown in the tax step and the tax settings for corporations only
 * (GmbH, UG, AG, GmbH & Co. KG). Sole proprietors and partnerships never see it (they book Privatentnahmen/-einlagen).
 */
export interface ShareholderClearingView {
  applies: boolean;
  mappedAccount: string | null;
  accounts: { number: string; name: string }[];
}

export function ShareholderClearingPanel() {
  return (
    <ConvexGuard fallback={null}>
      <ShareholderClearingInner />
    </ConvexGuard>
  );
}

function ShareholderClearingInner() {
  const status = useAuthedQuery(api.accounting.shareholderClearing, {});
  const setup = useMutation(api.accounting.setupShareholderAccounts);
  const canEdit = useCan("accounting.roles");
  const run = useRun();
  const t = useTranslations("shareholderClearing");
  if (!status) return null;
  return (
    <ShareholderClearingForm
      view={status}
      canEdit={canEdit}
      onSubmit={async (shareholders) => {
        const r = await run(() => setup({ shareholders }), t("created"));
        return r.ok;
      }}
    />
  );
}

interface Row {
  key: number;
  name: string;
  number: string;
}

export function ShareholderClearingForm({
  view,
  canEdit,
  onSubmit,
}: {
  view: ShareholderClearingView;
  canEdit: boolean;
  onSubmit: (shareholders: { name: string; number?: string }[]) => Promise<boolean>;
}) {
  const t = useTranslations("shareholderClearing");
  const id = useId();
  const [rows, setRows] = useState<Row[]>([{ key: 0, name: "", number: "" }]);
  const [busy, setBusy] = useState(false);
  if (!view.applies) return null;
  const mapped = view.mappedAccount !== null;
  return (
    <Card className="mt-8" aria-labelledby={`${id}-title`}>
      <CardHeader>
        <CardTitle id={`${id}-title`} className="text-base">
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {mapped ? (
          <div>
            <p className="text-sm">{t("mapped", { account: view.mappedAccount ?? "" })}</p>
            <ul className="mt-2 list-disc pl-5 text-sm">
              {view.accounts.map((a) => (
                <li key={a.number}>
                  {a.number} {a.name}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-warning" role="status">
            {t("unmapped")}
          </p>
        )}
        {!mapped && canEdit ? (
          <form
            className="@container/form flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const ok = await onSubmit(
                rows
                  .filter((r) => r.name.trim())
                  .map((r) => ({ name: r.name.trim(), ...(r.number.trim() ? { number: r.number.trim() } : {}) })),
              );
              setBusy(false);
              if (ok) setRows([{ key: 0, name: "", number: "" }]);
            }}
          >
            {rows.map((r, i) => (
              <div key={r.key} className="grid gap-2 @md/form:grid-cols-[1fr_10rem_auto] @md/form:items-end">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${id}-name-${r.key}`}>{t("shareholder", { n: i + 1 })}</Label>
                  <Input
                    id={`${id}-name-${r.key}`}
                    value={r.name}
                    autoComplete="name"
                    onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, name: e.target.value } : x)))}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${id}-nr-${r.key}`}>{t("number")}</Label>
                  <Input
                    id={`${id}-nr-${r.key}`}
                    value={r.number}
                    inputMode="numeric"
                    placeholder={t("numberPlaceholder")}
                    onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, number: e.target.value } : x)))}
                  />
                </div>
                {rows.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-11 md:h-9"
                    aria-label={t("remove", { n: i + 1 })}
                    onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
                  >
                    <Trash2Icon className="size-4" aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            ))}
            <p className="text-muted-foreground text-xs">{t("numberHint")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-11 md:h-9"
                onClick={() =>
                  setRows([...rows, { key: Math.max(...rows.map((x) => x.key)) + 1, name: "", number: "" }])
                }
              >
                <PlusIcon className="size-4" aria-hidden="true" />
                {t("add")}
              </Button>
              <Button type="submit" className="h-11 md:h-9" disabled={busy || !rows.some((r) => r.name.trim())}>
                {t("create")}
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
