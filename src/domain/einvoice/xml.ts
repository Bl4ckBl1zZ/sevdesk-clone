/**
 * Minimal deterministic XML writer for the CII/UBL serializers (ADR-007 fallback "own builder"): no dependencies,
 * synchronous, identical bytes for identical input (golden files, sha256 of artifacts). Text is XML-escaped and
 * characters that XML 1.0 cannot carry are dropped (DOC-58, EC-DOC-80; control characters are already stripped on
 * input, this is the last line of defence).
 */
import { formatDecimal } from "../money/format";

export interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  readonly text?: string;
}

type Child = XmlElement | null | undefined | false;

/** Element with child elements; null/undefined/false children are skipped, empty containers are omitted. */
export function el(
  name: string,
  attrs: Readonly<Record<string, string | undefined>> | null,
  ...children: Child[]
): XmlElement | null {
  const kids = children.filter((c): c is XmlElement => !!c);
  if (kids.length === 0) return null;
  return { name, attrs: cleanAttrs(attrs), children: kids };
}

/** Leaf element with text; undefined/empty values produce no element. */
export function leaf(
  name: string,
  value: string | undefined | null,
  attrs: Readonly<Record<string, string | undefined>> | null = null,
): XmlElement | null {
  if (value === undefined || value === null || value === "") return null;
  return { name, attrs: cleanAttrs(attrs), children: [], text: value };
}

function cleanAttrs(attrs: Readonly<Record<string, string | undefined>> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

// XML 1.0 Char production: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove them
const INVALID_XML_CHARS = /[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu;

/** Escapes element text (&, <, >; CR kept as a character reference). */
export function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;");
}

const escapeAttr = (value: string): string => escapeXml(value).replace(/"/g, "&quot;");

function write(node: XmlElement, indent: number, out: string[]): void {
  const pad = "  ".repeat(indent);
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join("");
  if (node.text !== undefined) {
    out.push(`${pad}<${node.name}${attrs}>${escapeXml(node.text)}</${node.name}>`);
    return;
  }
  out.push(`${pad}<${node.name}${attrs}>`);
  for (const c of node.children) write(c, indent + 1, out);
  out.push(`${pad}</${node.name}>`);
}

/** Serialises a document with an XML declaration, two-space indentation and a trailing newline. */
export function renderXml(root: XmlElement): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  write(root, 0, out);
  return `${out.join("\n")}\n`;
}

const dot = (s: string) => s.replace(/\./g, "").replace(",", ".");

/** Cents → "1190.00" / "-120.00". */
export const amount = (cents: number): string => dot(formatDecimal(cents, 2));
/** 1/1,000 → "10" / "2.5" / "0.125". */
export const quantity = (milli: number): string => dot(formatDecimal(milli, 3, { minFractionDigits: 0 }));
/** 1/10,000 → "100.00" / "10.005" / "16.8". Minimum 2 decimals. */
export const price = (micros: number): string => dot(formatDecimal(micros, 4, { minFractionDigits: 2 }));
/** Basis points → "19.00". */
export const percent = (bp: number): string => dot(formatDecimal(bp, 2));
/** "2026-10-12" → "20261012" (CII format 102). */
export const date102 = (d: string): string => d.replaceAll("-", "");
