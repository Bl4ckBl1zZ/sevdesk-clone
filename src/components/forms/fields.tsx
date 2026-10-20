"use client";

import type * as React from "react";
import { useEffect, useId, useRef } from "react";
import { type FieldValues, get, type Path, type UseFormReturn } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Form field helpers (04-ui-ux §7): every control has a visible label, errors are linked via
 * aria-describedby and marked aria-invalid; react-hook-form focuses the first invalid field on submit.
 * Native inputs/selects/checkboxes keep labelling robust and give phones their native pickers.
 */

function useFieldIds() {
  const id = useId();
  return { id, descId: `${id}-desc`, errorId: `${id}-error` };
}

function errorOf<T extends FieldValues>(form: UseFormReturn<T>, name: Path<T>): string | undefined {
  const err = get(form.formState.errors, name) as { message?: string } | undefined;
  return err?.message;
}

function describedBy(...ids: (string | false | undefined)[]) {
  const v = ids.filter(Boolean).join(" ");
  return v || undefined;
}

function Label({ htmlFor, children, required }: { htmlFor: string; children: React.ReactNode; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="font-medium text-sm leading-snug">
      {children}
      {required && (
        <span aria-hidden="true" className="text-danger">
          {" "}
          *
        </span>
      )}
    </label>
  );
}

function Hint({ id, children }: { id: string; children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} className="text-muted-foreground text-sm">
      {children}
    </p>
  );
}

function ErrorText({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-danger text-sm">
      {message}
    </p>
  );
}

type BaseProps<T extends FieldValues> = {
  form: UseFormReturn<T>;
  name: Path<T>;
  label: string;
  description?: React.ReactNode;
  required?: boolean;
  className?: string;
};

export function TextField<T extends FieldValues>({
  form,
  name,
  label,
  description,
  required,
  className,
  ...inputProps
}: BaseProps<T> & Omit<React.ComponentProps<"input">, "name" | "form" | "id">) {
  const { id, descId, errorId } = useFieldIds();
  const error = errorOf(form, name);
  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-invalid={error ? true : undefined}>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      <Input
        id={id}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(description !== undefined && descId, error && errorId)}
        className="h-11 md:h-9"
        {...inputProps}
        {...form.register(name)}
      />
      <Hint id={descId}>{description}</Hint>
      <ErrorText id={errorId} message={error} />
    </div>
  );
}

export function SelectField<T extends FieldValues>({
  form,
  name,
  label,
  description,
  required,
  className,
  options,
  placeholder,
  disabled,
}: BaseProps<T> & {
  options: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const { id, descId, errorId } = useFieldIds();
  const error = errorOf(form, name);
  const { ref: registerRef, ...registration } = form.register(name);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  // Options often come from a query that resolves after the form: the uncontrolled select then shows the
  // placeholder although the form holds the value, so re-apply the form value whenever the options change.
  const optionValues = options.map((o) => o.value).join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync exactly when the option values change
  useEffect(() => {
    const el = selectRef.current;
    const value = form.getValues(name);
    if (el && value != null && el.value !== String(value)) el.value = String(value);
  }, [optionValues]);
  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-invalid={error ? true : undefined}>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      <select
        ref={(el) => {
          registerRef(el);
          selectRef.current = el;
        }}
        id={id}
        disabled={disabled}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(description !== undefined && descId, error && errorId)}
        className="h-11 w-full rounded-md border border-input bg-background px-2.5 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive md:h-9 md:text-sm dark:bg-input/30"
        {...registration}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Hint id={descId}>{description}</Hint>
      <ErrorText id={errorId} message={error} />
    </div>
  );
}

export function CheckboxField<T extends FieldValues>({
  form,
  name,
  label,
  description,
  className,
  disabled,
}: Omit<BaseProps<T>, "required"> & { disabled?: boolean }) {
  const { id, descId, errorId } = useFieldIds();
  const error = errorOf(form, name);
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(description !== undefined && descId, error && errorId)}
          className="mt-0.5 size-5 shrink-0 accent-primary md:size-4"
          {...form.register(name)}
        />
        <label htmlFor={id} className="text-sm leading-snug">
          {label}
        </label>
      </div>
      <div className="pl-8 md:pl-7">
        <Hint id={descId}>{description}</Hint>
        <ErrorText id={errorId} message={error} />
      </div>
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** Shown instead of the hint when disabled ("greyed with the reason", F01 §6.2). */
  disabledReason?: string;
}

export function RadioCardGroup<T extends FieldValues>({
  form,
  name,
  label,
  description,
  required,
  className,
  options,
  columns = 1,
}: BaseProps<T> & { options: RadioOption[]; columns?: 1 | 2 | 3 }) {
  const { id, descId, errorId } = useFieldIds();
  const error = errorOf(form, name);
  return (
    <fieldset
      className={cn("flex flex-col gap-2", className)}
      aria-describedby={describedBy(description !== undefined && descId, error && errorId)}
    >
      <legend className="mb-1 font-medium text-sm">
        {label}
        {required && (
          <span aria-hidden="true" className="text-danger">
            {" "}
            *
          </span>
        )}
      </legend>
      <Hint id={descId}>{description}</Hint>
      <div
        className={cn("grid gap-2", columns === 2 && "@md/form:grid-cols-2", columns === 3 && "@md/form:grid-cols-3")}
      >
        {options.map((o) => {
          const optionId = `${id}-${o.value}`;
          const hint = o.disabled && o.disabledReason ? o.disabledReason : o.hint;
          return (
            <label
              key={o.value}
              htmlFor={optionId}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                o.disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                id={optionId}
                type="radio"
                value={o.value}
                disabled={o.disabled}
                aria-describedby={hint ? `${optionId}-hint` : undefined}
                className="mt-0.5 size-5 shrink-0 accent-primary md:size-4"
                {...form.register(name)}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm">{o.label}</span>
                {hint && (
                  <span id={`${optionId}-hint`} className="text-muted-foreground text-xs">
                    {hint}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      <ErrorText id={errorId} message={error} />
    </fieldset>
  );
}

/** Polite summary for screen readers after a failed submit (04-ui-ux §7). */
export function FormErrorSummary<T extends FieldValues>({ form }: { form: UseFormReturn<T> }) {
  const count = Object.keys(form.formState.errors).length;
  return (
    <p aria-live="polite" className="sr-only">
      {form.formState.isSubmitted && count > 0 ? `Bitte ${count === 1 ? "ein Feld" : `${count} Felder`} prüfen.` : ""}
    </p>
  );
}
