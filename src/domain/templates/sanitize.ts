/**
 * Template body sanitiser (F01 SET-081). Allowlist: p, br, strong, em, u, ul, ol, li, a (http/https/mailto),
 * table/tr/td; every attribute except a[href] is removed; script-like elements are dropped with their content;
 * other tags are removed but their text is kept; stray angle brackets are escaped. Pure and deterministic, so the
 * same function runs in the editor preview and on every save (Convex, REST, MCP).
 */
import { err, issue, ok, type Result } from "../result";

export const MAX_TEMPLATE_LENGTH = 20_000;

const ALLOWED = new Set(["p", "br", "strong", "em", "u", "ul", "ol", "li", "a", "table", "tr", "td"]);
const VOID = new Set(["br"]);
/** Elements whose content is never text for the reader. */
const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "noscript",
  "template",
  "textarea",
  "title",
  "svg",
  "math",
  "head",
]);
const SAFE_SCHEMES = ["http://", "https://", "mailto:"];

const TOKEN = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
const HREF = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;|&newline;/gi, "");
}

/** True for http(s) and mailto targets, after removing whitespace/control characters and entity tricks. */
export function isSafeHref(raw: string): boolean {
  const v = [...decodeEntities(raw)]
    .filter((c) => (c.codePointAt(0) ?? 0) > 0x20)
    .join("")
    .toLowerCase();
  return SAFE_SCHEMES.some((s) => v.startsWith(s));
}

const escapeAttr = (v: string) => v.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function sanitizeTemplateHtml(html: string): string {
  let out = "";
  let dropping: { tag: string; depth: number } | null = null;
  for (const m of html.matchAll(TOKEN)) {
    const [token, closing, rawName, attrs] = m;
    if (token.startsWith("<!--")) continue;
    if (rawName === undefined) {
      if (dropping) continue;
      out += token === "<" ? "&lt;" : token.replace(/>/g, "&gt;");
      continue;
    }
    const name = rawName.toLowerCase();
    const selfClosing = /\/\s*$/.test(attrs ?? "");
    if (dropping) {
      if (name === dropping.tag) {
        if (closing) dropping.depth -= 1;
        else if (!selfClosing) dropping.depth += 1;
        if (dropping.depth === 0) dropping = null;
      }
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing && !selfClosing) dropping = { tag: name, depth: 1 };
      continue;
    }
    if (!ALLOWED.has(name)) continue;
    if (closing) {
      if (!VOID.has(name)) out += `</${name}>`;
      continue;
    }
    if (name === "a") {
      const href = HREF.exec(attrs ?? "");
      const value = href ? (href[1] ?? href[2] ?? href[3] ?? "") : "";
      out += value && isSafeHref(value) ? `<a href="${escapeAttr(value.trim())}">` : "<a>";
      continue;
    }
    out += `<${name}>`;
  }
  return out;
}

/** SET-081: length limit of the stored (sanitised) body. */
export function validateTemplateBody(body: string): Result<string> {
  if (body.length > MAX_TEMPLATE_LENGTH) return err(issue("TEMPLATE_TOO_LONG", "Höchstens 20.000 Zeichen."));
  return ok(body);
}
