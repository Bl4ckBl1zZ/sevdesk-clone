import { type Finding, findingCategory } from "../../src/domain/einvoice/verdict";
import { validatePdf, validateXml } from "./einvoiceTools";
import { env, isTest } from "./env";

/**
 * Validation of RECEIVED E-Rechnungen (F06 INB-024) via the einvoice-tools sidecar: XML → `/validate/xml` (KoSIT),
 * hybrid PDF → `/validate/pdf` (Mustang). Unlike the outbound check (convex/lib/einvoiceTools.ts) a missing sidecar
 * is never „skipped“: the outcome is `unavailable` and the item stays `processing` with retries (EC-INB-13) — an
 * inbound invoice is never „valid“ by default, not even in tests. Tests install `inboundValidatorFake.impl`.
 */
export type InboundOutcome =
  | { kind: "done"; acceptable: boolean; report: string; tool: string; findings: Finding[] }
  | { kind: "unavailable"; detail: string };

export interface InboundValidator {
  validateXml(xml: string): Promise<InboundOutcome>;
  validatePdf(pdf: Uint8Array): Promise<InboundOutcome>;
}

const mapFindings = (errors: readonly { ruleId: string; text: string }[]): Finding[] =>
  errors.map((e) => ({ ruleId: e.ruleId, text: e.text.slice(0, 1000), category: findingCategory(e.ruleId) }));

export const sidecarValidator: InboundValidator = {
  async validateXml(xml) {
    if (!env("EINVOICE_TOOLS_URL")) return { kind: "unavailable", detail: "EINVOICE_TOOLS_URL nicht gesetzt" };
    const r = await validateXml(xml);
    if (r.kind === "passed")
      return {
        kind: "done",
        acceptable: true,
        report: r.report,
        tool: `${r.tool.name} ${r.tool.version}`,
        findings: [],
      };
    if (r.kind === "failed")
      return { kind: "done", acceptable: false, report: r.report, tool: "kosit", findings: mapFindings(r.errors) };
    return { kind: "unavailable", detail: r.kind === "unavailable" ? r.detail : "nicht verfügbar" };
  },
  async validatePdf(pdf) {
    if (!env("EINVOICE_TOOLS_URL")) return { kind: "unavailable", detail: "EINVOICE_TOOLS_URL nicht gesetzt" };
    const r = await validatePdf(pdf);
    if (r.kind === "passed")
      return {
        kind: "done",
        acceptable: true,
        report: r.report,
        tool: `${r.tool.name} ${r.tool.version}`,
        findings: [],
      };
    if (r.kind === "failed")
      return { kind: "done", acceptable: false, report: r.report, tool: "mustang", findings: mapFindings(r.errors) };
    return { kind: "unavailable", detail: r.kind === "unavailable" ? r.detail : "nicht verfügbar" };
  },
};

/** Test hook (module state, shared by the actions of one convex-test process). */
export const inboundValidatorFake = {
  impl: null as InboundValidator | null,
  calls: { xml: 0, pdf: 0 },
  reset() {
    this.impl = null;
    this.calls = { xml: 0, pdf: 0 };
  },
};

const unavailable: InboundValidator = {
  validateXml: async () => ({ kind: "unavailable", detail: "Prüfdienst nicht erreichbar" }),
  validatePdf: async () => ({ kind: "unavailable", detail: "Prüfdienst nicht erreichbar" }),
};

export function inboundValidator(): InboundValidator {
  if (!isTest() || (env("EINVOICE_TOOLS_URL") && !inboundValidatorFake.impl)) return sidecarValidator;
  const fake = inboundValidatorFake.impl ?? unavailable;
  return {
    validateXml: (xml) => {
      inboundValidatorFake.calls.xml++;
      return fake.validateXml(xml);
    },
    validatePdf: (pdf) => {
      inboundValidatorFake.calls.pdf++;
      return fake.validatePdf(pdf);
    },
  };
}
