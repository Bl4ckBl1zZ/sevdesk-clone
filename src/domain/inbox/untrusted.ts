/**
 * Untrusted text (F06 INB-030, 06 §2.7, EC-INB-19, EC-189): text extracted from documents (OCR, e-mail subject/body,
 * XML free text) is returned in a clearly delimited `untrusted_text` field and never mixed into tool instructions.
 * The UI renders it escaped (React text nodes); this module only strips control characters and limits the length.
 */

/** Removes control and bidi-override characters except tab/newline and normalises line endings. */
export function sanitizeUntrusted(value: string): string {
  return (
    value
      .replace(/\r\n?/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove them
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, "")
      .trim()
  );
}

/** `{ untrusted_text }` for MCP/REST payloads, or null for empty values. */
export function untrustedText(value: string | undefined | null, maxLen = 4000): { untrusted_text: string } | null {
  if (value === undefined || value === null) return null;
  const clean = sanitizeUntrusted(value);
  if (!clean) return null;
  return { untrusted_text: clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean };
}
