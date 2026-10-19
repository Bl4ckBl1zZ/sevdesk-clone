/**
 * Optional sender allowlist of the e-mail-in address (F06 INB-051, EC-INB-06). Entries are full addresses
 * (`rechnung@telekom.de`) or whole domains (`@telekom.de`). Messages from other senders are imported like all others
 * but flagged `unknown_sender` — never dropped, never auto-rejected; the Worker does not filter. Pure.
 */

const ADDRESS_RE = /^[^\s@<>(),;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const DOMAIN_RE = /^@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** One entry per line or comma/semicolon separated; lower-cased, de-duplicated, invalid entries dropped. */
export function parseAllowlist(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (!ADDRESS_RE.test(entry) && !DOMAIN_RE.test(entry)) continue;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Invalid entries of the input (for the settings form). */
export function invalidAllowlistEntries(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((e) => e.trim())
    .filter((e) => e && !ADDRESS_RE.test(e.toLowerCase()) && !DOMAIN_RE.test(e.toLowerCase()));
}

/** Empty allowlist → every sender is allowed. A message without a parseable sender is unknown. */
export function senderAllowed(from: string | undefined, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const address = from?.trim().toLowerCase();
  if (!address?.includes("@")) return false;
  const domain = address.slice(address.lastIndexOf("@"));
  return allowlist.some((e) => (e.startsWith("@") ? e === domain : e === address));
}
