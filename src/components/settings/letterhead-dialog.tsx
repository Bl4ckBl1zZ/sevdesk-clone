"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import { UploadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { uploadFile } from "@/components/banking/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";

type Slot = "first" | "follow";

export interface LetterheadLayout {
  readonly layoutId: string;
  readonly name: string;
  readonly letterhead?: boolean;
  readonly letterheadFollow?: boolean;
}

/**
 * F01 SET-072 „Briefpapier“: upload (checked server-side: A4 portrait, 1–2 pages, ≤ 5 MB, no JavaScript, no
 * encryption, embedded fonts) or removal of the letterhead of one layout; every change is a new layout version.
 */
export function LetterheadDialog({ layout, onClose }: { layout: LetterheadLayout; onClose: () => void }) {
  const t = useTranslations("letterhead");
  const tCommon = useTranslations("common");
  const uploadUrl = useMutation(api.settings.generateLogoUploadUrl);
  const upload = useAction(api.documentArtifacts.uploadLetterhead);
  const remove = useMutation(api.settings.removeLetterhead);
  const showError = useAdapterErrorToast();
  const [busy, setBusy] = useState<Slot | null>(null);
  const [state, setState] = useState({ first: !!layout.letterhead, follow: !!layout.letterheadFollow });
  const layoutId = layout.layoutId as Id<"layouts">;

  const onFile = async (slot: Slot, file: File | undefined) => {
    if (!file) return;
    setBusy(slot);
    try {
      const storageId = await uploadFile(await uploadUrl({}), file);
      await upload({ layoutId, storageId, slot });
      setState((s) => ({ ...s, [slot]: true }));
      toast.success(t("uploaded"));
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  };
  const onRemove = async (slot: Slot) => {
    setBusy(slot);
    try {
      await remove({ layoutId, slot });
      setState((s) => (slot === "first" ? { first: false, follow: false } : { ...s, follow: false }));
      toast.success(t("removed"));
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title", { name: layout.name })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <SlotRow
            slot="first"
            present={state.first}
            busy={busy}
            onFile={onFile}
            onRemove={onRemove}
            disabledReason={null}
          />
          <SlotRow
            slot="follow"
            present={state.follow}
            busy={busy}
            onFile={onFile}
            onRemove={onRemove}
            disabledReason={state.first ? null : t("followNeedsFirst")}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {tCommon("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SlotRow({
  slot,
  present,
  busy,
  onFile,
  onRemove,
  disabledReason,
}: {
  slot: Slot;
  present: boolean;
  busy: Slot | null;
  onFile: (slot: Slot, file: File | undefined) => Promise<void>;
  onRemove: (slot: Slot) => Promise<void>;
  disabledReason: string | null;
}) {
  const t = useTranslations("letterhead");
  const inputId = useId();
  const hintId = useId();
  const disabled = busy !== null || disabledReason !== null;
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-3 text-sm" aria-labelledby={`${inputId}-h`}>
      <span className="flex flex-wrap items-center gap-2 font-medium">
        <span id={`${inputId}-h`}>{t(slot)}</span>
        <Badge variant={present ? "default" : "outline"}>{present ? t("present") : t("missing")}</Badge>
      </span>
      {disabledReason && (
        <span id={hintId} className="text-muted-foreground">
          {disabledReason}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={inputId}
          className={`inline-flex h-11 cursor-pointer items-center gap-2 rounded-md border px-3 font-medium md:h-8 ${
            disabled ? "pointer-events-none opacity-50" : "hover:bg-accent"
          }`}
        >
          <UploadIcon aria-hidden="true" className="size-4" />
          {busy === slot ? t("uploading") : t("upload")}
          <span className="sr-only"> ({t(slot)})</span>
        </label>
        <input
          id={inputId}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          disabled={disabled}
          aria-describedby={disabledReason ? hintId : undefined}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            void onFile(slot, file);
          }}
        />
        {present && (
          <Button
            variant="outline"
            size="sm"
            className="h-11 md:h-8"
            disabled={busy !== null}
            onClick={() => void onRemove(slot)}
          >
            {t("remove")}
            <span className="sr-only"> ({t(slot)})</span>
          </Button>
        )}
      </div>
    </section>
  );
}
