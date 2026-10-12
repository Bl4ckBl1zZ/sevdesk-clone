import { SEEDED_RANGES as DOMAIN_SEEDS } from "@/domain/numbering/format";
import type { NumberRangesFormValues } from "@/domain/schemas/settings";

/**
 * Form values of the seeded number ranges (F01 §5.5, SET-006/SET-053) until the server has stored them; the seed
 * table itself is domain data (src/domain/numbering/format.ts).
 */
export const SEEDED_RANGES: NumberRangesFormValues["ranges"] = DOMAIN_SEEDS.map((r) => ({
  key: r.key,
  name: r.name,
  format: r.format,
  resetPolicy: r.resetPolicy,
  next: r.startValue,
}));
