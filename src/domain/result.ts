/**
 * Shared result and issue shapes for the pure domain layer.
 * Errors carry a stable snake_case `code` (05 §2 problem details), a German `message` shown verbatim,
 * and optional `params` for UI/API rendering (F03 §5, F04 §5.1).
 */
export interface Issue<C extends string = string> {
  readonly code: C;
  readonly message: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

export type Result<T, E = Issue> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value });

export const err = <E>(error: E): { readonly ok: false; readonly error: E } => ({ ok: false, error });

export function issue<C extends string>(
  code: C,
  message: string,
  params?: Readonly<Record<string, string | number>>,
): Issue<C> {
  return params === undefined ? { code, message } : { code, message, params };
}
