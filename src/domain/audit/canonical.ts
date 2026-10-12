/**
 * JSON Canonicalization Scheme (RFC 8785, "JCS") — the serialisation the audit hash chain is computed over
 * (F12 AUD-004). Deterministic key order (UTF-16 code units), ECMAScript number and string serialisation,
 * no whitespace. `undefined` object members are omitted (like JSON.stringify); everything that has no JSON
 * representation (NaN, Infinity, bigint, functions, symbols, undefined at the top level or in arrays) throws.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalize: non-finite number at ${path}`);
      // ECMAScript Number::toString is exactly the JCS number format (RFC 8785 §3.2.2.3); -0 → "0".
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((item, i) => {
            if (item === undefined) throw new TypeError(`canonicalize: undefined at ${path}[${i}]`);
            return serialize(item, `${path}[${i}]`);
          })
          .join(",")}]`;
      }
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        throw new TypeError(`canonicalize: binary value at ${path}`);
      }
      const record = value as Record<string, unknown>;
      // Default sort compares UTF-16 code units, as RFC 8785 §3.2.3 requires.
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(record[k], `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalize: unsupported ${typeof value} at ${path}`);
  }
}
