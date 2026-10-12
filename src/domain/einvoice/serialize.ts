/**
 * Format → XML (F04 §4.6.3, §4.10.2, App. A.7). One call per artifact: the snapshot is mapped to the EN 16931 model
 * with the profile the format needs and written with the matching syntax.
 *
 * Serializer choice (ADR-007 fallback, docs/adr/0004 spike 5): own deterministic CII/UBL writers instead of
 * `@e-invoice-eu/core` — the library merges all BT-22 notes into one CII `IncludedNote` (invalid against the
 * Factur-X EN16931 XSD for every final invoice), derives the CII from UBL-shaped JSON, pulls `child_process`/
 * `tmp-promise` into the bundle (not usable in this pure layer or the Convex runtime) and is async only.
 */
import type { DocumentSnapshot, EinvoiceFormat } from "../documents/snapshot";
import { serializeCii } from "./cii";
import { type MapOptions, mapToEn16931 } from "./map";
import type { En16931Invoice, XmlAttachment } from "./model";
import { serializeUbl } from "./ubl";

export type XmlFormat = Exclude<EinvoiceFormat, "none">;

export interface SerializedEinvoice {
  readonly format: XmlFormat;
  readonly syntax: "CII" | "UBL";
  readonly profile: MapOptions["profile"];
  /** Name inside a hybrid PDF (`factur-x.xml` / `xrechnung.xml`) or of the separate file. */
  readonly embeddedFileName: "factur-x.xml" | "xrechnung.xml" | null;
  readonly xml: string;
  readonly model: En16931Invoice;
}

const PLAN: Record<
  XmlFormat,
  { syntax: "CII" | "UBL"; profile: MapOptions["profile"]; embedded: SerializedEinvoice["embeddedFileName"] }
> = {
  zugferd_en16931: { syntax: "CII", profile: "en16931", embedded: "factur-x.xml" },
  zugferd_xrechnung: { syntax: "CII", profile: "xrechnung", embedded: "xrechnung.xml" },
  xrechnung_cii: { syntax: "CII", profile: "xrechnung", embedded: null },
  xrechnung_ubl: { syntax: "UBL", profile: "xrechnung", embedded: null },
};

export function serializeEinvoice(
  snapshot: DocumentSnapshot,
  format: XmlFormat,
  options: { readonly attachments?: readonly XmlAttachment[] } = {},
): SerializedEinvoice {
  const plan = PLAN[format];
  const model = mapToEn16931(snapshot, {
    profile: plan.profile,
    ...(options.attachments ? { attachments: options.attachments } : {}),
  });
  return {
    format,
    syntax: plan.syntax,
    profile: plan.profile,
    embeddedFileName: plan.embedded,
    xml: plan.syntax === "CII" ? serializeCii(model) : serializeUbl(model),
    model,
  };
}
