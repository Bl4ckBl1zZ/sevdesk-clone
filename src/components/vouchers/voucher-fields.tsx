"use client";

import type * as React from "react";
import { useId } from "react";
import { selectClass } from "@/components/catalog/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Small labelled controls of the voucher screens (one column on phones, two in wide containers). */

export function TextInput({
  label,
  value,
  onChange,
  hint,
  error,
  type = "text",
  inputMode,
  className,
  testId,
  required,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  error?: string;
  type?: "text" | "date" | "number";
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  className?: string;
  testId?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        inputMode={inputMode}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? hintId : undefined}
        aria-required={required || undefined}
        autoComplete={autoComplete ?? "off"}
        data-testid={testId}
        className="h-11 md:h-9"
        onChange={(e) => onChange(e.target.value)}
      />
      {(hint || error) && (
        <p id={hintId} className={cn("text-xs", error ? "text-danger" : "text-muted-foreground")}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  hint,
  className,
  rows = 3,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  className?: string;
  rows?: number;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        rows={rows}
        value={value}
        data-testid={testId}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-muted-foreground text-xs">
          {hint}
        </p>
      )}
    </div>
  );
}

export function SelectInput({
  label,
  value,
  onChange,
  options,
  hint,
  error,
  className,
  testId,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly { value: string; label: string }[];
  hint?: string;
  error?: string;
  className?: string;
  testId?: string;
  required?: boolean;
}) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className={selectClass}
        value={value}
        data-testid={testId}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={hint || error ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {(hint || error) && (
        <p id={`${id}-hint`} className={cn("text-xs", error ? "text-danger" : "text-muted-foreground")}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function CheckboxInput({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 accent-primary"
        checked={checked}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
      <Label htmlFor={id} className="font-normal leading-snug">
        {label}
      </Label>
    </div>
  );
}
