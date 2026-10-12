"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { type DefaultValues, type FieldValues, type Resolver, useForm } from "react-hook-form";
import type { z } from "zod";

/** react-hook-form with a zod schema; validates on submit, then live on change (04-ui-ux §1.5). */
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
  defaultValues: DefaultValues<z.input<S>>,
) {
  // The resolver's generic inference does not survive the generic schema parameter; the cast restores it.
  const resolver = zodResolver(schema) as unknown as Resolver<z.input<S>, unknown, z.output<S>>;
  return useForm<z.input<S>, unknown, z.output<S>>({
    resolver,
    defaultValues,
    mode: "onSubmit",
    reValidateMode: "onChange",
  });
}
