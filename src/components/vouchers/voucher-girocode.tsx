"use client";

import { QrCodeIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** QR module path (one unit square per dark module, 4-module quiet zone), error correction M as in F04 DOC-51. */
function qrSvg(payload: string): { d: string; units: number } {
  const { size, data } = QRCode.create(payload, { errorCorrectionLevel: "M" }).modules;
  const parts: string[] = [];
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) if (data[r * size + c]) parts.push(`M${c + 4} ${r + 4}h1v1h-1z`);
  return { d: parts.join(""), units: size + 8 };
}

/**
 * „Mit Banking-App bezahlen“ (F06 VOU-135): shows the GiroCode built on the server from the open amount, the
 * supplier IBAN and the document number. Read-only — the app never initiates a payment.
 */
export function VoucherGirocode({ payload, label }: { payload: string; label: string }) {
  const t = useTranslations("vouchers.detail");
  const [open, setOpen] = useState(false);
  const qr = useMemo(() => (open ? qrSvg(payload) : null), [open, payload]);
  return (
    <>
      <Button
        variant="outline"
        className="h-11 self-start md:h-9"
        onClick={() => setOpen(true)}
        data-testid="voucher-girocode"
      >
        <QrCodeIcon aria-hidden="true" />
        {t("girocode")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("girocodeTitle")}</DialogTitle>
            <DialogDescription>{t("girocodeHint")}</DialogDescription>
          </DialogHeader>
          {qr && (
            <svg
              role="img"
              aria-label={label}
              viewBox={`0 0 ${qr.units} ${qr.units}`}
              className="mx-auto size-64 rounded-md bg-white"
              shapeRendering="crispEdges"
            >
              <path d={qr.d} fill="#000000" />
            </svg>
          )}
          <DialogFooter>
            <Button variant="outline" className="h-11 md:h-9" onClick={() => setOpen(false)}>
              {t("close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
