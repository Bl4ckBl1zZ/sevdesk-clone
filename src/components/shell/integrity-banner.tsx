"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { ShieldAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { canDo } from "@/domain/access/permissions";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/**
 * Global integrity banner (F12 AUD-015, E-AUD-03, §6 „Global banner“): shown on every page while the latest
 * integrity run failed and is not acknowledged — finalising is blocked until then. Only the owner may acknowledge
 * (with a note; audited `integrity.acknowledge`, data is not altered). Roles without `integrity.read` see nothing.
 */
export function IntegrityBanner() {
  return (
    <ConvexGuard>
      <IntegrityBannerInner />
      <ClockBanner />
    </ConvexGuard>
  );
}

/** F12 AUD-019 / GOBD-22: clock skew > 2 s → warning banner; > 60 s → finalising and dated actions are refused. */
function ClockBanner() {
  const t = useTranslations("integrity");
  const me = useAuthedQuery(api.members.me, {});
  const canRead = Boolean(me && canDo(me.role, "integrity.read"));
  const clock = useAuthedQuery(api.system.clock, {}, canRead);
  if (!clock || (clock.status !== "warning" && clock.status !== "error")) return null;
  return (
    <div
      role={clock.status === "error" ? "alert" : "status"}
      className={
        clock.status === "error"
          ? "border-danger border-b bg-danger/10 px-4 py-3 text-sm"
          : "border-warning border-b bg-warning/10 px-4 py-3 text-sm"
      }
    >
      {t(clock.status === "error" ? "clockError" : "clockWarning", { detail: clock.detail })}
    </div>
  );
}

function IntegrityBannerInner() {
  const t = useTranslations("integrity");
  const me = useAuthedQuery(api.members.me, {});
  const canRead = Boolean(me && canDo(me.role, "integrity.read"));
  const status = useAuthedQuery(api.integrity.status, {}, canRead);
  const [open, setOpen] = useState(false);
  if (!me || !status?.finalisationBlocked || !status.lastRun) return null;

  const finding = status.lastRun.findings.find((f) => f.severity === "error") ?? status.lastRun.findings[0];
  const entity = finding?.entity ? `${finding.entity.table}/${finding.entity.id}` : (finding?.kind ?? "auditLog");
  const seq = finding?.firstBrokenSeq ?? status.lastRun.lastVerifiedSeq;
  const canAcknowledge = canDo(me.role, "integrity.acknowledge");

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 border-danger border-b bg-danger/10 px-4 py-3 text-sm md:flex-row md:items-center"
    >
      <ShieldAlertIcon className="hidden size-5 shrink-0 text-danger md:block" aria-hidden="true" />
      <p className="flex-1">
        {t("failed", { entity, seq })}
        {finding?.detail && <span className="block text-muted-foreground">{finding.detail}</span>}
      </p>
      {canAcknowledge && (
        <Button variant="outline" className="h-11 self-start md:h-8" onClick={() => setOpen(true)}>
          {t("acknowledge")}
        </Button>
      )}
      {canAcknowledge && <AcknowledgeDialog runId={status.lastRun.id} open={open} onOpenChange={setOpen} />}
    </div>
  );
}

function AcknowledgeDialog({
  runId,
  open,
  onOpenChange,
}: {
  runId: Id<"integrityRuns">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("integrity");
  const tCommon = useTranslations("common");
  const noteId = useId();
  const acknowledge = useMutation(api.integrity.acknowledge);
  const showError = useAdapterErrorToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("acknowledgeTitle")}</DialogTitle>
          <DialogDescription>{t("acknowledgeDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={noteId} className="font-medium text-sm">
            {t("note")}
          </label>
          <Textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} rows={4} />
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button
            className="h-11 md:h-9"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await acknowledge({ runId, note });
                toast.success(t("acknowledged"));
                onOpenChange(false);
              } catch (e) {
                showError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("acknowledgeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
