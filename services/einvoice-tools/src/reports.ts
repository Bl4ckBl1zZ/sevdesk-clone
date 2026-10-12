/**
 * Parsers for the two validator reports (02 §8). Zero dependencies on purpose: the reports have a small, stable
 * shape and the sidecar must not pull an XML stack into the image. Both parsers are tolerant: unknown elements are
 * ignored, and the raw report is always returned to the caller so nothing is lost.
 */

export type Level = "error" | "warning" | "information";

export interface Message {
  /** Rule ID such as `BR-DE-15`, or the validator's own code (`generic-error`, Mustang type number). */
  code: string;
  level: Level;
  location: string | null;
  text: string;
}

export interface KositResult {
  /** `rep:assessment/rep:accept` present — the KoSIT verdict "acceptable". */
  accepted: boolean;
  /** `valid` attribute of `rep:report` (schema + schematron result before the acceptance rule). */
  valid: boolean;
  scenario: string | null;
  errors: Message[];
  warnings: Message[];
  infos: Message[];
}

export interface MustangSection {
  present: boolean;
  valid: boolean;
}

export interface MustangResult {
  valid: boolean;
  pdf: MustangSection & { pdfaCompliant: boolean | null; flavour: string | null };
  xml: MustangSection & { profile: string | null };
  errors: Message[];
  warnings: Message[];
  notices: Message[];
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? "";
  });
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m?.[1] !== undefined ? decodeXml(m[1]) : null;
}

function squash(text: string): string {
  return decodeXml(text.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseLevel(level: string | null): Level {
  if (level === "error" || level === "fatal") return "error";
  if (level === "warning") return "warning";
  return "information";
}

/** KoSIT VARL report (`rep:report`, validator 1.6.x daemon response body). */
export function parseKositReport(xml: string): KositResult {
  const root = /<rep:report\b([^>]*)>/.exec(xml);
  const valid = root?.[1] ? attr(root[1], "valid") === "true" : false;
  const accepted = /<rep:assessment>\s*<rep:accept\b/.test(xml);
  const scenarioMatch = /<rep:scenarioMatched>[\s\S]*?<s:name>([\s\S]*?)<\/s:name>/.exec(xml);
  const scenario = scenarioMatch?.[1] ? squash(scenarioMatch[1]) : null;

  const errors: Message[] = [];
  const warnings: Message[] = [];
  const infos: Message[] = [];
  for (const m of xml.matchAll(/<rep:message\b([^>]*)>([\s\S]*?)<\/rep:message>/g)) {
    const attrs = m[1] ?? "";
    const msg: Message = {
      code: attr(attrs, "code") ?? attr(attrs, "id") ?? "unknown",
      level: normaliseLevel(attr(attrs, "level")),
      location: attr(attrs, "xpathLocation"),
      text: squash(m[2] ?? ""),
    };
    (msg.level === "error" ? errors : msg.level === "warning" ? warnings : infos).push(msg);
  }
  return { accepted, valid, scenario, errors, warnings, infos };
}

function sectionOf(xml: string, tag: "pdf" | "xml"): string | null {
  // Top-level <pdf>/<xml> sections of <validation>; never nested in each other.
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m?.[1] ?? null;
}

function summaryValid(fragment: string | null): boolean {
  if (fragment === null) return false;
  const all = [...fragment.matchAll(/<summary status="(valid|invalid)"\s*\/>/g)];
  return all.at(-1)?.[1] === "valid";
}

const MUSTANG_LEVELS: Record<string, keyof Pick<MustangResult, "errors" | "warnings" | "notices">> = {
  error: "errors",
  exception: "errors",
  fatal: "errors",
  warning: "warnings",
  notice: "notices",
};

/** Mustang CLI `--action validate` report (`<validation>` on stdout). */
export function parseMustangReport(xml: string): MustangResult {
  if (!/<validation\b/.test(xml)) throw new Error("not a Mustang validation report");
  const pdf = sectionOf(xml, "pdf");
  const xmlSection = sectionOf(xml, "xml");
  const compliant = pdf ? /isCompliant=(true|false)/.exec(pdf) : null;
  const flavour = pdf ? /flavour=([0-9a-z]+)/.exec(pdf) : null;
  const profile = xmlSection ? /<profile>([\s\S]*?)<\/profile>/.exec(xmlSection) : null;

  const result: MustangResult = {
    // The last <summary> in the document is the overall verdict.
    valid: summaryValid(xml),
    pdf: {
      present: pdf !== null,
      valid: summaryValid(pdf),
      pdfaCompliant: compliant ? compliant[1] === "true" : null,
      flavour: flavour?.[1] ?? null,
    },
    xml: {
      present: xmlSection !== null,
      valid: summaryValid(xmlSection),
      profile: profile?.[1] ? squash(profile[1]) : null,
    },
    errors: [],
    warnings: [],
    notices: [],
  };

  // <info> is a container (version, profile, duration) in Mustang reports, not a message.
  for (const m of xml.matchAll(/<(error|exception|fatal|warning|notice)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const kind = m[1] ?? "error";
    const attrs = m[2] ?? "";
    const text = squash(m[3] ?? "");
    const ruleId = /\[ID ([A-Z][A-Z0-9-]*-\d+[a-z]?)\]/.exec(text)?.[1] ?? /^\[([A-Z][A-Z0-9-]*-\d+)\]/.exec(text)?.[1];
    const bucket = MUSTANG_LEVELS[kind] ?? "errors";
    result[bucket].push({
      code: ruleId ?? `mustang-${attr(attrs, "type") ?? kind}`,
      level: bucket === "errors" ? "error" : bucket === "warnings" ? "warning" : "information",
      location: attr(attrs, "location"),
      text,
    });
  }
  return result;
}
