import { env, isTest } from "./env";

/**
 * Client of the einvoice-tools sidecar (services/einvoice-tools: KoSIT 1.6 + Mustang/veraPDF; ER-12, F04 INV-20).
 *
 *   POST {EINVOICE_TOOLS_URL}/validate/xml  → { acceptable, errors, warnings, scenario, … }
 *   POST {EINVOICE_TOOLS_URL}/validate/pdf  → { valid, pdfaValid, xmlValid, errors, … }
 *
 * Without `EINVOICE_TOOLS_URL` the validator is unavailable: finalisation of an E-Rechnung is refused with
 * `dependency_unavailable` (EC-007). Only test deployments (IS_TEST=true, no sidecar running) skip the check and
 * record `validation: "skipped"` on the document — never in production.
 */
export type ToolsOutcome =
  | { kind: "passed"; report: string; tool: { name: string; version: string } }
  | { kind: "failed"; errors: { ruleId: string; text: string }[]; report: string }
  | { kind: "skipped" }
  | { kind: "unavailable"; detail: string };

const TIMEOUT_MS = 20_000;

interface RawIssue {
  readonly id?: string;
  readonly ruleId?: string;
  readonly code?: string;
  readonly text?: string;
  readonly message?: string;
}

const issuesOf = (list: unknown): { ruleId: string; text: string }[] =>
  Array.isArray(list)
    ? (list as RawIssue[]).map((e) => ({
        ruleId: e.code ?? e.ruleId ?? e.id ?? "?",
        text: e.text ?? e.message ?? JSON.stringify(e),
      }))
    : [];

async function post(path: string, body: Uint8Array | string, contentType: string): Promise<ToolsOutcome | Response> {
  const base = env("EINVOICE_TOOLS_URL");
  if (!base)
    return isTest() ? { kind: "skipped" } : { kind: "unavailable", detail: "EINVOICE_TOOLS_URL nicht gesetzt" };
  try {
    return await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: "POST",
      body: typeof body === "string" ? body : new Blob([body as Uint8Array<ArrayBuffer>]),
      headers: { "content-type": contentType },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { kind: "unavailable", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** KoSIT check of an XRechnung / EN 16931 XML (preview and final XML). */
export async function validateXml(xml: string): Promise<ToolsOutcome> {
  const res = await post("/validate/xml", xml, "application/xml");
  if (!(res instanceof Response)) return res;
  if (!res.ok && res.status !== 422) return { kind: "unavailable", detail: `HTTP ${res.status}` };
  const text = await res.text();
  const json = JSON.parse(text) as {
    acceptable?: boolean;
    errors?: unknown;
    validatorVersion?: string;
    configVersion?: string;
  };
  if (res.ok && json.acceptable) {
    const version = `${json.validatorVersion ?? "?"} / ${json.configVersion ?? "?"}`;
    return { kind: "passed", report: text, tool: { name: "kosit", version } };
  }
  return { kind: "failed", errors: issuesOf(json.errors), report: text };
}

/** Mustang + veraPDF check of a hybrid or plain PDF/A-3b. */
export async function validatePdf(pdf: Uint8Array): Promise<ToolsOutcome> {
  const res = await post("/validate/pdf", pdf, "application/pdf");
  if (!(res instanceof Response)) return res;
  if (!res.ok) return { kind: "unavailable", detail: `HTTP ${res.status}` };
  const text = await res.text();
  const json = JSON.parse(text) as {
    valid?: boolean;
    pdfaValid?: boolean;
    xmlPresent?: boolean;
    errors?: unknown;
    mustangVersion?: string;
  };
  const ok = json.pdfaValid === true && (json.xmlPresent ? json.valid === true : true);
  return ok
    ? { kind: "passed", report: text, tool: { name: "mustang", version: json.mustangVersion ?? "?" } }
    : { kind: "failed", errors: issuesOf(json.errors), report: text };
}
