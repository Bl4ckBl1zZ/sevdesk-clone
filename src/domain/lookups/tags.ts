/** Tags (F01 SET-094): shared by contacts, products, documents and vouchers; mutable even on finalised documents. */
import { err, issue, ok, type Result } from "../result";

/** Theme palette names (Tailwind colour families used by the UI badges). */
export const TAG_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "indigo",
  "purple",
  "pink",
] as const;

export function validateTag(
  tag: { id?: string; name: string; color?: string },
  existing: readonly { id: string; name: string }[],
): Result<void> {
  const name = tag.name.trim();
  if (
    name.length < 1 ||
    name.length > 40 ||
    (tag.color !== undefined && !(TAG_COLORS as readonly string[]).includes(tag.color))
  ) {
    return err(issue("TAG_INVALID", "Name: 1 bis 40 Zeichen; Farbe aus der Palette."));
  }
  const key = name.toLocaleLowerCase("de");
  if (existing.some((t) => t.id !== tag.id && t.name.trim().toLocaleLowerCase("de") === key)) {
    return err(issue("TAG_DUPLICATE", "Ein Tag mit diesem Namen existiert bereits."));
  }
  return ok(undefined);
}
