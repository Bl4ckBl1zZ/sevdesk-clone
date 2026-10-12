/**
 * The e-mail address between `/anmelden` and `/anmelden/code` lives in sessionStorage (tab-scoped), not in the
 * URL, so it does not end up in history, logs or referrers.
 */
const KEY = "anmelden.email";

export function storePendingEmail(email: string): void {
  try {
    sessionStorage.setItem(KEY, email);
  } catch {
    // Storage disabled: the code page asks for the address again.
  }
}

export function readPendingEmail(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearPendingEmail(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
