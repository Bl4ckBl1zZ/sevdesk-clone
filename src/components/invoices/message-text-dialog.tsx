"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { CopyIcon, MailIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";

/**
 * F04 SND-19 „E-Mail-Text kopieren“: subject, body and the contact's invoice e-mail address(es), each with a copy
 * button, and a `mailto:` link (subject/body only, no attachments). The app sends nothing and logs nothing.
 */
export function MessageTextDialog({ id, onClose }: { id: Id<"salesDocuments">; onClose: () => void }) {
  const t = useTranslations("invoices.detail");
  const data = useAuthedQuery(api.invoices.messageText, { id });
  const subjectId = useId();
  const bodyId = useId();
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("mailCopied"));
    } catch {
      toast.error(t("mailCopyFailed"));
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("mailText")}</DialogTitle>
          <DialogDescription>{t("mailTextHint")}</DialogDescription>
        </DialogHeader>
        {data && (
          <div className="flex flex-col gap-4 text-sm" data-testid="message-text">
            <section className="flex flex-col gap-1.5">
              <h3 className="font-medium">{t("mailTo")}</h3>
              {data.recipients.length === 0 ? (
                <p className="text-muted-foreground">{t("mailNoRecipient")}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {data.recipients.map((r) => (
                    <li key={r} className="flex items-center justify-between gap-2">
                      <span className="truncate">{r}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-11 md:h-8"
                        aria-label={t("mailCopyValue", { value: r })}
                        onClick={() => void copy(r)}
                      >
                        <CopyIcon aria-hidden="true" />
                        {t("mailCopy")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={subjectId} className="font-medium">
                  {t("mailSubject")}
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 md:h-8"
                  aria-label={t("mailCopyValue", { value: t("mailSubject") })}
                  onClick={() => void copy(data.subject)}
                >
                  <CopyIcon aria-hidden="true" />
                  {t("mailCopy")}
                </Button>
              </div>
              <Input id={subjectId} readOnly value={data.subject} />
            </section>
            <section className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={bodyId} className="font-medium">
                  {t("mailBody")}
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 md:h-8"
                  aria-label={t("mailCopyValue", { value: t("mailBody") })}
                  onClick={() => void copy(data.body)}
                >
                  <CopyIcon aria-hidden="true" />
                  {t("mailCopy")}
                </Button>
              </div>
              <Textarea id={bodyId} readOnly rows={8} value={data.body} />
            </section>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {t("mailClose")}
          </Button>
          {data && (
            <a href={data.mailto} className={cn(buttonVariants(), "h-11 md:h-9")}>
              <MailIcon aria-hidden="true" />
              {t("mailOpen")}
            </a>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
