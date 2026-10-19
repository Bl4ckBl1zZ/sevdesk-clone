/**
 * VOU-100 batch queue („Belege nacheinander bearbeiten“): the selected drafts are worked through one by one with
 * progress („3 von 17“), `⌘/Strg+Enter` „Buchen und weiter“, `s` überspringen, `j`/`k` vor/zurück, `d` „Ist Dublette“,
 * `r` verwerfen (deletes the draft after a confirmation — the inbox „ablehnen“ arrives with INB-*). Pure state; the
 * component binds it to the editor and the Convex mutations.
 */

export interface QueueState {
  /** Ordered voucher ids (deduplicated). */
  ids: readonly string[];
  /** Index of the voucher shown. */
  index: number;
  /** Booked or removed (deleted/duplicate) — never shown again. */
  done: readonly string[];
  skipped: readonly string[];
}

export type QueueKeyAction = "book_next" | "skip" | "next" | "prev" | "duplicate" | "reject";

export function createQueue(ids: readonly string[]): QueueState {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  return { ids: unique, index: 0, done: [], skipped: [] };
}

export function currentId(s: QueueState): string | null {
  return s.ids[s.index] ?? null;
}

const pending = (s: QueueState, id: string) => !s.done.includes(id);

/** „3 von 17“: position of the shown voucher in the queue. */
export function progressLabel(s: QueueState): string {
  if (s.ids.length === 0) return "0 von 0";
  return `${Math.min(s.index + 1, s.ids.length)} von ${s.ids.length}`;
}

export function doneCount(s: QueueState): number {
  return s.done.length;
}

export function isFinished(s: QueueState): boolean {
  return s.ids.every((id) => s.done.includes(id));
}

/** Next pending voucher after `from` (wrapping around to the skipped ones); stays put when none is left. */
function seek(s: QueueState, from: number, step: 1 | -1): number {
  const n = s.ids.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + step * k) % n) + n) % n;
    const id = s.ids[i];
    if (id !== undefined && pending(s, id)) return i;
  }
  return from;
}

/** `j`: next pending voucher. */
export function next(s: QueueState): QueueState {
  return s.ids.length === 0 ? s : { ...s, index: seek(s, s.index, 1) };
}

/** `k`: previous pending voucher. */
export function prev(s: QueueState): QueueState {
  return s.ids.length === 0 ? s : { ...s, index: seek(s, s.index, -1) };
}

/** `s`: skip — remembered, shown again after the others. */
export function skip(s: QueueState): QueueState {
  const id = currentId(s);
  if (!id) return s;
  const skipped = s.skipped.includes(id) ? s.skipped : [...s.skipped, id];
  return next({ ...s, skipped });
}

/** After „Buchen und weiter“, „Ist Dublette“ or „Verwerfen“: the voucher leaves the queue and the next one shows. */
export function complete(s: QueueState, id: string): QueueState {
  if (!s.ids.includes(id) || s.done.includes(id)) return s;
  const done = [...s.done, id];
  const after = { ...s, done, skipped: s.skipped.filter((x) => x !== id) };
  return isFinished(after) ? after : { ...after, index: seek(after, s.ids.indexOf(id), 1) };
}

export interface KeyInput {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  /** The event target is a text field, select or editable element. */
  inField?: boolean;
}

/** Keyboard map; letter shortcuts are ignored while typing in a field, `⌘/Strg+Enter` always works. */
export function queueKeyAction(e: KeyInput): QueueKeyAction | null {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return "book_next";
  if (e.inField || e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case "s":
      return "skip";
    case "j":
      return "next";
    case "k":
      return "prev";
    case "d":
      return "duplicate";
    case "r":
      return "reject";
    default:
      return null;
  }
}

/** `/belege/warteschlange?ids=a,b,c` ⇄ ids (raw Convex ids, order kept). */
export function queueHref(ids: readonly string[]): string {
  return `/belege/warteschlange?ids=${ids.map(encodeURIComponent).join(",")}`;
}

export function parseQueueIds(param: string | null | undefined): string[] {
  if (!param) return [];
  return param
    .split(",")
    .map((x) => decodeURIComponent(x.trim()))
    .filter((x) => /^[0-9a-zA-Z]{1,64}$/.test(x));
}
