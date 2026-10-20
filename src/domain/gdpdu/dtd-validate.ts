/**
 * F09 EXP-017 / E-EXP-31: validates an XML document against a DTD's element content models — the domain-layer
 * equivalent of `xmllint --noout --dtdvalid gdpdu-01-09-2004.dtd index.xml` for the subset the GDPdU DTD uses
 * (element declarations with EMPTY, (#PCDATA) and children content models; no attributes, no mixed content).
 *
 * Checks: well-formedness (nesting, closing tags, entities), DOCTYPE root name, every element declared, EMPTY
 * elements empty, #PCDATA elements without child elements, children models matched exactly (sequence, choice,
 * `?`, `*`, `+`), no character data between child elements, no attributes (the DTD declares none).
 */

type Model = { kind: "empty" } | { kind: "pcdata" } | { kind: "children"; source: string; regex: RegExp };

export interface XmlElement {
  name: string;
  children: XmlElement[];
  text: string;
  hasAttributes: boolean;
}

/** Parses `<!ELEMENT name model>` declarations (comments stripped). */
export function parseDtd(dtd: string): Map<string, Model> {
  const out = new Map<string, Model>();
  const text = dtd.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of text.matchAll(/<!ELEMENT\s+([A-Za-z_][\w.-]*)\s+([^>]+)>/g)) {
    const name = m[1] as string;
    const model = (m[2] as string).trim();
    if (model === "EMPTY") out.set(name, { kind: "empty" });
    else if (/^\(\s*#PCDATA\s*\)$/.test(model)) out.set(name, { kind: "pcdata" });
    else if (model.includes("#PCDATA") || model === "ANY") throw new Error(`unsupported content model for ${name}`);
    else out.set(name, { kind: "children", source: model, regex: modelRegex(model) });
  }
  return out;
}

/** `(A, (B | C)?, D*)` → /^(?:A,)(?:(?:B,)|(?:C,))?(?:D,)*$/ over the child sequence "A,B,D,D,". */
function modelRegex(model: string): RegExp {
  let re = "";
  for (const tok of model.match(/[A-Za-z_][\w.-]*|[(),|?*+]/g) ?? []) {
    if (tok === ",") continue;
    if (tok === "(") re += "(?:";
    else if (tok === ")" || tok === "|" || tok === "?" || tok === "*" || tok === "+") re += tok;
    else re += `(?:${tok},)`;
  }
  return new RegExp(`^${re}$`);
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string, errors: string[]): string {
  return s.replace(/&([^;\s&]*);?/g, (all, ref: string) => {
    if (!all.endsWith(";")) {
      errors.push(`Ungültiges Zeichen „&“ (nicht maskiert).`);
      return all;
    }
    if (ref.startsWith("#x")) return String.fromCodePoint(Number.parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(Number.parseInt(ref.slice(1), 10));
    const v = ENTITIES[ref];
    if (v === undefined) errors.push(`Unbekannte Entität &${ref};`);
    return v ?? "";
  });
}

/** Minimal XML parser for generated documents (prolog, DOCTYPE, comments, elements, text). */
export function parseXml(xml: string): {
  root: XmlElement | null;
  doctype: { root: string; system: string } | null;
  errors: string[];
} {
  const errors: string[] = [];
  let doctype: { root: string; system: string } | null = null;
  let i = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  const src = xml.replace(/^﻿/, "");
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const text = src.slice(i, lt === -1 ? src.length : lt);
    if (text.length > 0) {
      const top = stack.at(-1);
      if (top) top.text += decodeEntities(text, errors);
      else if (text.trim()) errors.push("Text außerhalb des Wurzelelements.");
    }
    if (lt === -1) break;
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt);
      if (end === -1) return { root, doctype, errors: [...errors, "Verarbeitungsanweisung nicht geschlossen."] };
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt);
      if (end === -1) return { root, doctype, errors: [...errors, "Kommentar nicht geschlossen."] };
      i = end + 3;
      continue;
    }
    if (src.startsWith("<!DOCTYPE", lt)) {
      const end = src.indexOf(">", lt);
      const m = /^<!DOCTYPE\s+([\w.-]+)\s+SYSTEM\s+"([^"]+)"\s*>$/.exec(src.slice(lt, end + 1));
      if (!m) errors.push("DOCTYPE-Deklaration ungültig.");
      else doctype = { root: m[1] as string, system: m[2] as string };
      i = end + 1;
      continue;
    }
    const gt = src.indexOf(">", lt);
    if (gt === -1) return { root, doctype, errors: [...errors, "Tag nicht geschlossen."] };
    const tag = src.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const open = stack.pop();
      if (!open || open.name !== name) {
        errors.push(`Schließendes Tag </${name}> passt nicht zu <${open?.name ?? "—"}>.`);
        return { root, doctype, errors };
      }
      continue;
    }
    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const m = /^([A-Za-z_][\w.-]*)(\s+[\s\S]*)?$/.exec(body.trim());
    if (!m) {
      errors.push(`Ungültiges Tag <${tag}>.`);
      return { root, doctype, errors };
    }
    const el: XmlElement = { name: m[1] as string, children: [], text: "", hasAttributes: Boolean(m[2]?.trim()) };
    const parent = stack.at(-1);
    if (parent) parent.children.push(el);
    else if (root) errors.push("Mehr als ein Wurzelelement.");
    else root = el;
    if (!selfClosing) stack.push(el);
  }
  if (stack.length > 0) errors.push(`Element <${stack.at(-1)?.name}> nicht geschlossen.`);
  return { root, doctype, errors };
}

/** E-EXP-31: validation errors (German, one per problem); empty = valid. */
export function validateAgainstDtd(xml: string, dtd: string, dtdFile: string): string[] {
  const models = parseDtd(dtd);
  const { root, doctype, errors } = parseXml(xml);
  if (!root) return [...errors, "Kein Wurzelelement."];
  if (!doctype) errors.push("DOCTYPE fehlt.");
  else {
    if (doctype.root !== root.name) errors.push(`DOCTYPE nennt ${doctype.root}, Wurzel ist ${root.name}.`);
    if (doctype.system !== dtdFile) errors.push(`DOCTYPE verweist auf ${doctype.system} statt ${dtdFile}.`);
  }
  const walk = (el: XmlElement, path: string) => {
    const here = `${path}/${el.name}`;
    const model = models.get(el.name);
    if (!model) {
      errors.push(`${here}: Element ist in der DTD nicht deklariert.`);
      return;
    }
    if (el.hasAttributes) errors.push(`${here}: Attribute sind nicht erlaubt.`);
    if (model.kind === "empty") {
      if (el.children.length > 0 || el.text.length > 0) errors.push(`${here}: muss leer sein.`);
    } else if (model.kind === "pcdata") {
      if (el.children.length > 0) errors.push(`${here}: darf nur Text enthalten.`);
    } else {
      if (el.text.trim().length > 0) errors.push(`${here}: Text ist hier nicht erlaubt.`);
      const seq = el.children.map((c) => `${c.name},`).join("");
      if (!model.regex.test(seq)) {
        errors.push(
          `${here}: Inhalt (${el.children.map((c) => c.name).join(", ") || "leer"}) passt nicht zu ${model.source}.`,
        );
      }
    }
    for (const c of el.children) walk(c, here);
  };
  walk(root, "");
  return errors;
}
