/**
 * P0 spike 5 (09-roadmap, ADR-007, docs/adr/0004-pdf-einvoice-spikes.md): can `@e-invoice-eu/core` produce
 * KoSIT-acceptable XRechnung UBL/CII and ZUGFeRD EN16931 from our model, incl. TypeCodes 326/380/381/875 and a 380
 * final invoice with negative BT-115?
 *
 * The library's input is UBL-shaped JSON ("ubl:Invoice", attributes as "cbc:X@attr"). We feed it the content of our
 * own XRechnung UBL for the golden cases (parsed back into that JSON shape), let it serialise XRECHNUNG-UBL,
 * XRECHNUNG-CII and Factur-X-EN16931 (hybrid PDF from our PDF/A-3b) and post every result to the einvoice-tools
 * sidecar (KoSIT + Mustang).
 *
 *   EINVOICE_TOOLS_URL=http://127.0.0.1:8080 pnpm tsx scripts/spikes/einvoice-eu-core.ts
 */
import { type Invoice, InvoiceService, invoiceSchema } from "@e-invoice-eu/core";
import { serializeEinvoice } from "@/domain/einvoice/serialize";
import { renderPdf } from "@/pdf/render-artifacts";
import { goldenSnapshot, loadGoldenCases } from "../../test/golden/cases";

const url = process.env.EINVOICE_TOOLS_URL ?? "http://127.0.0.1:8080";
const CASES = [
  "de-19-standard",
  "advance-invoice-30",
  "storno-full",
  "advance-rate-change",
  "construction-advance-875",
  "ku-invoice",
];

type Json = Record<string, unknown>;
interface Node {
  name: string;
  attrs: Record<string, string>;
  text?: string;
  children: Node[];
}

const xmlUnescape = (s: string) =>
  s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#13;", "\r")
    .replaceAll("&amp;", "&");

/** Parser for our own renderXml output (one element per line). */
function parse(xml: string): Node {
  const stack: Node[] = [];
  let root: Node | null = null;
  let pending = "";
  for (const raw of xml.split("\n").slice(1)) {
    // Text values may span lines (BT-20 Skonto line): join until the element closes.
    const line = pending ? `${pending}\n${raw}` : raw.trim();
    if (!line) continue;
    if (/^<[\w:]+[^>]*>[^<]*$/.test(line) && !line.endsWith(">")) {
      pending = line;
      continue;
    }
    if (/^<([\w:]+)[^>]*>[^<]+$/.test(line)) {
      pending = line;
      continue;
    }
    pending = "";
    if (line.startsWith("</")) {
      stack.pop();
      continue;
    }
    const m = /^<([\w:]+)((?:\s+[\w:]+="[^"]*")*)>(?:([\s\S]*)<\/\1>)?$/.exec(line);
    if (!m) throw new Error(`cannot parse ${line}`);
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? "").matchAll(/([\w:]+)="([^"]*)"/g)) attrs[a[1] as string] = xmlUnescape(a[2] as string);
    const node: Node = { name: m[1] as string, attrs, children: [] };
    if (m[3] !== undefined) node.text = xmlUnescape(m[3]);
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else root = node;
    if (m[3] === undefined) stack.push(node);
  }
  if (!root) throw new Error("empty");
  return root;
}

const credit = (name: string) =>
  name
    .replace("CreditNoteLine", "InvoiceLine")
    .replace("CreditedQuantity", "InvoicedQuantity")
    .replace("CreditNoteTypeCode", "InvoiceTypeCode");

/** Our UBL tree → the library's JSON, guided by its JSON schema (arrays vs objects). */
function toJson(node: Node, schema: Json): Json {
  const props = (schema.properties ?? {}) as Record<string, Json>;
  const out: Json = {};
  for (const c of node.children) {
    const key = credit(c.name);
    const prop = props[key];
    if (!prop) throw new Error(`schema has no ${key}`);
    const isArray = prop.type === "array";
    const itemSchema = (isArray ? prop.items : prop) as Json;
    const value = c.text !== undefined ? c.text : toJson(c, itemSchema);
    if (isArray) out[key] = [...((out[key] as unknown[]) ?? []), value];
    else out[key] = value;
    for (const [a, v] of Object.entries(c.attrs)) out[`${key}@${a}`] = v;
  }
  return out;
}

async function kosit(xml: string) {
  const r = await fetch(`${url}/validate/xml`, { method: "POST", body: xml });
  const j = (await r.json()) as { acceptable: boolean; errors: { text?: string }[] };
  return j.acceptable ? "acceptable" : `REJECTED ${j.errors.map((e) => e.text).join(" | ")}`;
}

async function mustang(pdf: Uint8Array) {
  const r = await fetch(`${url}/validate/pdf`, {
    method: "POST",
    body: Buffer.from(pdf),
    headers: { "content-type": "application/pdf" },
  });
  const j = (await r.json()) as { valid: boolean; pdfaValid: boolean; xmlValid: boolean; errors: unknown[] };
  return j.valid ? "valid" : `INVALID pdfa=${j.pdfaValid} xml=${j.xmlValid} ${JSON.stringify(j.errors).slice(0, 400)}`;
}

const logger = {
  log: () => {},
  warn: (m: string) => console.warn(`  warn: ${m}`),
  error: (m: string) => console.error(`  error: ${m}`),
};
const service = new InvoiceService(logger);
const rootSchema = (invoiceSchema as unknown as { properties: Record<string, Json> }).properties["ubl:Invoice"] as Json;

for (const c of loadGoldenCases().filter((x) => CASES.includes(x.dir))) {
  const s = goldenSnapshot(c);
  const ours = serializeEinvoice(s, "xrechnung_ubl");
  const invoice = { "ubl:Invoice": toJson(parse(ours.xml), rootSchema) } as unknown as Invoice;
  console.info(`\n${c.file.id} ${c.dir} (BT-3 ${ours.model.typeCode}, BT-115 ${ours.model.totals.payableCents / 100})`);
  console.info(`  ours XRECHNUNG-UBL      ${await kosit(ours.xml)}`);
  for (const format of ["XRECHNUNG-UBL", "XRECHNUNG-CII", "CII"]) {
    try {
      const xml = (await service.generate(structuredClone(invoice), {
        format,
        lang: "de-de",
        noWarnings: true,
      })) as string;
      console.info(`  lib  ${format.padEnd(18)} ${await kosit(xml)}`);
    } catch (e) {
      console.info(`  lib  ${format.padEnd(18)} THROWS ${(e as Error).message.slice(0, 300)}`);
    }
  }
  try {
    const pdf = await renderPdf(s, c.layout, "original");
    const hybrid = (await service.generate(structuredClone(invoice), {
      format: "Factur-X-EN16931",
      lang: "de-de",
      noWarnings: true,
      pdf: { buffer: pdf, filename: "invoice.pdf", mimetype: "application/pdf" },
    })) as Uint8Array;
    console.info(`  lib  Factur-X-EN16931   ${await mustang(hybrid)}`);
  } catch (e) {
    console.info(`  lib  Factur-X-EN16931   THROWS ${(e as Error).message.slice(0, 300)}`);
  }
}
