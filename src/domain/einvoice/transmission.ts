/**
 * 01 ER-30: the e-invoice is built once as the format-agnostic EN 16931 semantic model (`mapToEn16931`) and only then
 * serialised (CII/UBL, ZUGFeRD/XRechnung profiles). Transmission is a pluggable layer on top of the archived files:
 *  - `manual` (v1, owner decision B2): the owner exports the archived files and marks the document as sent;
 *  - `peppol` (P4, ViDA 2030 / XRechnung 4.0 in 2027): reserved, disabled until an access point is configured.
 * A new channel adds an entry here (plus its adapter outside the domain); the model and serialisers stay unchanged.
 */
import { type ExportFileSpec, exportFiles } from "../documents/dispatch";
import type { EinvoiceFormat } from "../documents/snapshot";

export type TransmissionChannelId = "manual" | "peppol";

export type TransmissionPlan =
  | {
      readonly kind: "manual_export";
      /** Archived files the owner hands over (same as the default export, §4.10.2). */
      readonly files: readonly ExportFileSpec[];
      /** The owner records the handover with „Als versendet markieren“ (SND-07). */
      readonly markRequired: true;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface TransmissionChannel {
  readonly id: TransmissionChannelId;
  readonly label: string;
  readonly enabled: boolean;
  /** XML syntaxes the channel can carry. */
  readonly syntaxes: readonly ("CII" | "UBL")[];
  plan(format: EinvoiceFormat): TransmissionPlan;
}

export const TRANSMISSION_CHANNELS: Readonly<Record<TransmissionChannelId, TransmissionChannel>> = {
  manual: {
    id: "manual",
    label: "Export und manueller Versand",
    enabled: true,
    syntaxes: ["CII", "UBL"],
    plan: (format) => ({ kind: "manual_export", files: exportFiles(format, "default", false), markRequired: true }),
  },
  peppol: {
    id: "peppol",
    label: "Peppol",
    enabled: false,
    syntaxes: ["UBL", "CII"],
    plan: () => ({ kind: "unavailable", reason: "Peppol ist noch nicht angebunden (geplant für P4)." }),
  },
};

/** The plan of a channel; a disabled channel never transmits. */
export function transmissionPlan(channel: TransmissionChannelId, format: EinvoiceFormat): TransmissionPlan {
  const c = TRANSMISSION_CHANNELS[channel];
  const plan = c.plan(format);
  if (!c.enabled && plan.kind !== "unavailable")
    return { kind: "unavailable", reason: `${c.label} ist nicht aktiviert.` };
  return plan;
}

/** Channels the UI may offer today. */
export const enabledTransmissionChannels = (): TransmissionChannel[] =>
  Object.values(TRANSMISSION_CHANNELS).filter((c) => c.enabled);
