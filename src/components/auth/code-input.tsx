"use client";

import { useTranslations } from "next-intl";
import { useRef } from "react";
import { cn } from "@/lib/utils";

export const CODE_LENGTH = 6;

/**
 * Six single-digit inputs (04-ui-ux §4.9): `inputmode="numeric"`, `autocomplete="one-time-code"` on the first
 * field, paste or autofill fills all fields, Backspace moves back.
 */
export function CodeInput({
  value,
  onChange,
  legend,
  invalid,
  describedBy,
  disabled,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  legend: string;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const t = useTranslations("auth");
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const chars = Array.from({ length: CODE_LENGTH }, (_, i) => value[i] ?? "");

  const focus = (i: number) => refs.current[Math.max(0, Math.min(CODE_LENGTH - 1, i))]?.focus();

  const fillFrom = (index: number, text: string) => {
    const digits = text.replace(/\D/g, "");
    if (!digits) return;
    const next = [...chars];
    for (let k = 0; k < digits.length && index + k < CODE_LENGTH; k++) next[index + k] = digits[k] ?? "";
    onChange(next.join(""));
    focus(index + digits.length);
  };

  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={describedBy}>
      <legend className="mb-2 font-medium text-sm">{legend}</legend>
      <div className="flex justify-between gap-2">
        {chars.map((char, i) => (
          <input
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length positional inputs
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={i === 0 ? "one-time-code" : "off"}
            // biome-ignore lint/a11y/noAutofocus: the code step has a single purpose
            autoFocus={autoFocus && i === 0}
            aria-label={t("codeDigit", { n: i + 1 })}
            aria-invalid={invalid ? true : undefined}
            disabled={disabled}
            value={char}
            className={cn(
              "h-12 w-full min-w-0 rounded-md border border-input bg-transparent text-center font-mono text-xl tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive",
            )}
            onChange={(e) => {
              const v = e.target.value;
              if (v.length > 1) return fillFrom(i, v); // autofill / IME delivers the whole code
              const digit = v.replace(/\D/g, "");
              const next = [...chars];
              next[i] = digit;
              onChange(next.join(""));
              if (digit) focus(i + 1);
            }}
            onPaste={(e) => {
              e.preventDefault();
              fillFrom(i, e.clipboardData.getData("text"));
            }}
            onKeyDown={(e) => {
              if (e.key === "Backspace" && !chars[i] && i > 0) {
                e.preventDefault();
                const next = [...chars];
                next[i - 1] = "";
                onChange(next.join(""));
                focus(i - 1);
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                focus(i - 1);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                focus(i + 1);
              }
            }}
            onFocus={(e) => e.target.select()}
          />
        ))}
      </div>
    </fieldset>
  );
}
