/**
 * Custom field definitions and values (F01 SET-095/096, §5.12). Values are validated by type on every write path
 * (GOBD-03); the key is immutable; the type is locked once a value exists; archiving hides values, finalised
 * documents keep their frozen values (GOBD-06).
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import { isCalendarDate } from "../time/calendar-date";

export const CUSTOM_FIELD_ENTITIES = ["contact", "product", "document"] as const;
export const CUSTOM_FIELD_TYPES = ["text", "number", "date", "select", "boolean"] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export const CUSTOM_FIELD_LIMIT = 30;
export const CUSTOM_FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_TEXT = 1000;

export interface CustomFieldDefInput {
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  options?: readonly string[];
}

export function validateCustomFieldDef(
  def: CustomFieldDefInput,
  existing: readonly { entity: CustomFieldEntity; key: string }[],
): Result<void> {
  if (!CUSTOM_FIELD_KEY.test(def.key)) {
    return err(
      issue("CUSTOM_FIELD_KEY_INVALID", "Schlüssel: Kleinbuchstaben, Ziffern und _, beginnend mit einem Buchstaben."),
    );
  }
  const sameEntity = existing.filter((d) => d.entity === def.entity);
  if (sameEntity.some((d) => d.key === def.key))
    return err(issue("CUSTOM_FIELD_DUPLICATE", "Dieses Feld existiert bereits."));
  if (sameEntity.length >= CUSTOM_FIELD_LIMIT) {
    return err(issue("CUSTOM_FIELD_LIMIT", "Höchstens 30 eigene Felder pro Bereich."));
  }
  return validateDefShape(def);
}

function validateDefShape(def: Pick<CustomFieldDefInput, "label" | "type" | "options">): Result<void> {
  if (def.label.trim().length < 1 || def.label.trim().length > 60) {
    return err(issue("CUSTOM_FIELD_LABEL", "Bezeichnung: 1 bis 60 Zeichen."));
  }
  if (def.type === "select") {
    const options = def.options ?? [];
    if (options.length < 1 || options.length > 50 || options.some((o) => o.trim() === "")) {
      return err(issue("CUSTOM_FIELD_OPTIONS", "Auswahlfelder brauchen 1 bis 50 Optionen."));
    }
  }
  return ok(undefined);
}

/** SET-096: changes to an existing definition (label/options/print flag free; key never; type only without values). */
export function checkCustomFieldChange(
  before: { key: string; type: CustomFieldType },
  after: Pick<CustomFieldDefInput, "key" | "type"> & Partial<Pick<CustomFieldDefInput, "label" | "options">>,
  valueCount: number,
): Issue | null {
  if (after.key !== before.key)
    return issue("CUSTOM_FIELD_KEY_LOCKED", "Der Schlüssel eines Feldes kann nicht geändert werden.");
  if (after.type !== before.type && valueCount > 0) {
    return issue(
      "CUSTOM_FIELD_TYPE_LOCKED",
      "Der Typ kann nicht geändert werden, weil bereits Werte gespeichert sind.",
    );
  }
  if (after.label !== undefined) {
    const shape = validateDefShape({
      label: after.label,
      type: after.type,
      ...(after.options ? { options: after.options } : {}),
    });
    if (!shape.ok) return shape.error;
  }
  return null;
}

/** SET-095: a value for `def` (undefined/empty = not set; required fields must be set). */
export function validateCustomFieldValue(
  def: { label: string; type: CustomFieldType; options?: readonly string[]; required?: boolean },
  value: unknown,
): Result<void> {
  const invalid = () =>
    err(issue("CUSTOM_FIELD_VALUE_INVALID", `„${def.label}“: ungültiger Wert.`, { label: def.label }));
  if (value === undefined || value === null || value === "") return def.required ? invalid() : ok(undefined);
  switch (def.type) {
    case "text":
      return typeof value === "string" && value.length <= MAX_TEXT ? ok(undefined) : invalid();
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? ok(undefined) : invalid();
    case "date":
      return typeof value === "string" && isCalendarDate(value) ? ok(undefined) : invalid();
    case "select":
      return typeof value === "string" && (def.options ?? []).includes(value) ? ok(undefined) : invalid();
    case "boolean":
      return typeof value === "boolean" ? ok(undefined) : invalid();
  }
}
