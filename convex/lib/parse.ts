import type { z } from "zod";
import { appError } from "./errors";

/** Server-side re-validation with the shared zod schema (SET-143); German message of the first issue. */
export function parse<S extends z.ZodType>(schema: S, values: unknown): z.output<S> {
  const r = schema.safeParse(values);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
  throw appError("invalid_input", issues[0]?.message, { issues });
}
