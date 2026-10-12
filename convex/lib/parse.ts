import type { Value } from "convex/values";
import type { z } from "zod";
import { appError } from "./errors";

/**
 * Server-side re-validation with the shared zod schema (SET-143); German message of the first issue. Domain rules
 * added in refinements carry their spec code (`params.code`), returned as `reason` like model errors.
 */
export function parse<S extends z.ZodType>(schema: S, values: unknown): z.output<S> {
  const r = schema.safeParse(values);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
  const first = r.error.issues[0] as { params?: { code?: unknown } } | undefined;
  const extra: Record<string, Value> = { issues };
  if (typeof first?.params?.code === "string") extra.reason = first.params.code;
  throw appError("invalid_input", issues[0]?.message, extra);
}
