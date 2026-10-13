"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Copies `value` to the clipboard; `label` is the accessible name (e.g. „Schlüssel kopieren“). */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const t = useTranslations("apiKeys");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={className ?? "size-11 shrink-0 md:size-9"}
      aria-label={label}
      title={label}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
    </Button>
  );
}
