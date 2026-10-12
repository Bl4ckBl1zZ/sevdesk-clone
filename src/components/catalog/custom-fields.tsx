"use client";

import { api } from "@convex/_generated/api";
import { useId } from "react";
import { Input } from "@/components/ui/input";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type Value = string | number | boolean;

/**
 * Custom fields (F01 SET-095) for contacts and products (CON-110, PRD-062): one control per active definition of the
 * entity; values are validated by type on the server (validateCustomFieldValue).
 */
export function CustomFieldsEditor({
  entity,
  value,
  onChange,
}: {
  entity: "contact" | "product";
  value: Record<string, Value>;
  onChange: (next: Record<string, Value>) => void;
}) {
  const defs = (useAuthedQuery(api.lookups.listCustomFields, {}) ?? []).filter((d) => d.entity === entity);
  if (defs.length === 0) return null;
  const set = (key: string, v: Value | undefined) => {
    const next = { ...value };
    if (v === undefined || v === "") delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <>
      {defs.map((d) => (
        <CustomField key={d.customFieldId} def={d} value={value[d.key]} onChange={(v) => set(d.key, v)} />
      ))}
    </>
  );
}

function CustomField({
  def,
  value,
  onChange,
}: {
  def: { key: string; label: string; type: string; options: string[]; required: boolean };
  value: Value | undefined;
  onChange: (v: Value | undefined) => void;
}) {
  const id = useId();
  const label = (
    <label htmlFor={id} className="font-medium text-sm">
      {def.label}
      {def.required && (
        <span aria-hidden="true" className="text-danger">
          {" "}
          *
        </span>
      )}
    </label>
  );
  if (def.type === "boolean") {
    return (
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="checkbox"
          className="size-5 accent-primary md:size-4"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked ? true : undefined)}
        />
        {label}
      </div>
    );
  }
  if (def.type === "select") {
    return (
      <div className="flex flex-col gap-1.5">
        {label}
        <select
          id={id}
          aria-required={def.required || undefined}
          className="h-11 rounded-md border border-input bg-background px-2.5 text-base md:h-9 md:text-sm dark:bg-input/30"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">—</option>
          {def.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {label}
      <Input
        id={id}
        aria-required={def.required || undefined}
        className="h-11 md:h-9"
        type={def.type === "date" ? "date" : "text"}
        inputMode={def.type === "number" ? "decimal" : undefined}
        value={value === undefined || typeof value === "boolean" ? "" : String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          if (def.type === "number") {
            const n = Number(raw.replace(",", "."));
            onChange(raw === "" ? undefined : Number.isFinite(n) ? n : raw);
          } else onChange(raw || undefined);
        }}
      />
    </div>
  );
}

/** Tag checkboxes (SET-094) for contacts and products. */
export function TagPicker({
  value,
  onChange,
  legend,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  legend: string;
}) {
  const tags = useAuthedQuery(api.lookups.listTags, {}) ?? [];
  if (tags.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-2 @lg/form:col-span-2">
      <legend className="mb-1 font-medium text-sm">{legend}</legend>
      <div className="flex flex-wrap gap-3">
        {tags.map((t) => (
          <label key={t.tagId} className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
            <input
              type="checkbox"
              className="size-5 accent-primary md:size-4"
              checked={value.includes(t.tagId)}
              onChange={(e) => onChange(e.target.checked ? [...value, t.tagId] : value.filter((x) => x !== t.tagId))}
            />
            {t.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
