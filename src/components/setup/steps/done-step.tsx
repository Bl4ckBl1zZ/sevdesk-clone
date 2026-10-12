"use client";

import { CircleAlertIcon, CircleXIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { isNotConnected } from "@/components/not-connected";
import { Button } from "@/components/ui/button";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { type ChecklistItem, completeSetup, getSetupChecklist, type SetupChecklist } from "../actions";
import { useWizard } from "../wizard-context";

/**
 * Step 11 "Fertig" (F01 SET-004, SET-008): checklist from the same domain validator that guards finalisation,
 * grouped "Pflicht" / "Empfohlen", each item linking to the field that fixes it. "Einrichtung abschließen" is
 * enabled only without blocking items.
 */
export function DoneStep() {
  const t = useTranslations("setup.done");
  const router = useRouter();
  const { formId } = useWizard();
  const showAdapterError = useAdapterErrorToast();
  const [checklist, setChecklist] = useState<SetupChecklist | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [completing, setCompleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setChecklist(await getSetupChecklist());
      setUnavailable(false);
    } catch (e) {
      setChecklist(null);
      setUnavailable(true);
      if (!isNotConnected(e)) showAdapterError(e);
    }
  }, [showAdapterError]);

  useEffect(() => {
    void load();
  }, [load]);

  const canComplete = !!checklist && checklist.blocking.length === 0;

  return (
    <form
      id={formId}
      noValidate
      className="flex flex-col gap-6"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!canComplete) return;
        setCompleting(true);
        try {
          await completeSetup();
          toast.success(t("completed"));
          router.push("/");
        } catch (err) {
          showAdapterError(err);
        } finally {
          setCompleting(false);
        }
      }}
    >
      {unavailable && <p className="text-muted-foreground text-sm">{t("checklistUnavailable")}</p>}
      {checklist && (
        <>
          <Group title={t("required")} items={checklist.blocking} tone="error" empty={t("noBlocking")} />
          {checklist.warnings.length > 0 && (
            <Group title={t("recommended")} items={checklist.warnings} tone="warning" />
          )}
        </>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" className="h-11 md:h-9" disabled={!canComplete || completing}>
          {t("complete")}
        </Button>
        <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => void load()}>
          {t("recheck")}
        </Button>
      </div>
    </form>
  );
}

function Group({
  title,
  items,
  tone,
  empty,
}: {
  title: string;
  items: ChecklistItem[];
  tone: "error" | "warning";
  empty?: string;
}) {
  const Icon = tone === "error" ? CircleXIcon : CircleAlertIcon;
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h2 className="font-medium text-sm">{title}</h2>
      {items.length === 0 && empty ? (
        <p className="text-sm text-success">{empty}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {items.map((item) => (
            <li key={item.code} className="flex items-start gap-3 p-3 text-sm">
              <Icon className={tone === "error" ? "size-5 text-danger" : "size-5 text-warning"} aria-hidden="true" />
              <Link href={item.href as never} className="underline underline-offset-4">
                {item.message}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
