import { InfoIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * AO-04 / SET-093: the app has no POS/„Kasse“ mode (§ 146a AO, TSE). Shown on /kasse: cash is a payment on an issued
 * invoice; there is no cash sale without an invoice.
 */
export function NoPosNotice() {
  const t = useTranslations("pages.kasse");
  return (
    <p
      role="note"
      className="mb-4 flex items-start gap-2 rounded-md border border-info/30 bg-info/10 p-3 text-info text-sm"
    >
      <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {t("noPos")}
    </p>
  );
}
