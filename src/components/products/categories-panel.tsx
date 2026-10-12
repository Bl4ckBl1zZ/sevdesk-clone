"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ConfirmDialog, FormDialog, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { SelectField, TextField } from "@/components/forms/fields";
import { EmptyState } from "@/components/layout/empty-state";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Button } from "@/components/ui/button";
import { MAX_CATEGORY_DEPTH } from "@/domain/products/categories";
import { categorySchema } from "@/domain/schemas/products";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type Category = FunctionReturnType<typeof api.products.categories>[number];

/** PRD-060/061: category tree (max. 3 levels) with product counts; delete moves products and children. */
export function CategoriesPanel() {
  return (
    <ConvexGuard fallback={<div className="h-64" aria-busy="true" />}>
      <CategoriesInner />
    </ConvexGuard>
  );
}

const depth = (c: Category) => c.path.split(" > ").length;

function CategoriesInner() {
  const t = useTranslations("products.categories");
  const categories = useAuthedQuery(api.products.categories, {});
  const canWrite = useCan("products.write");
  const [editing, setEditing] = useState<Category | "new" | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  if (categories === undefined) return <div className="h-64" aria-busy="true" />;
  return (
    <div className="flex flex-col gap-4">
      {canWrite && (
        <Button className="h-11 self-start md:h-9" onClick={() => setEditing("new")}>
          <PlusIcon aria-hidden="true" />
          {t("add")}
        </Button>
      )}
      {categories.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <ul className="divide-y rounded-xl border" aria-label={t("add")}>
          {categories.map((c) => (
            <li
              key={c._id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 pr-3 text-sm"
              style={{ paddingLeft: `${0.75 + (depth(c) - 1) * 1.25}rem` }}
            >
              <span className="flex flex-col">
                <span className="font-medium">{c.name}</span>
                <span className="text-muted-foreground text-xs">
                  {c.path} · {t("products", { count: c.productCount })}
                </span>
              </span>
              {canWrite && (
                <span className="flex gap-1">
                  <Button
                    variant="ghost"
                    className="h-11 md:h-8"
                    onClick={() => setEditing(c)}
                    aria-label={`${t("edit")}: ${c.name}`}
                  >
                    {t("edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-11 text-danger md:h-8"
                    onClick={() => setDeleting(c)}
                    aria-label={`${t("delete")}: ${c.name}`}
                  >
                    {t("delete")}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <CategoryDialog
          category={editing === "new" ? undefined : editing}
          categories={categories}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && <DeleteDialog category={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function CategoryDialog({
  category,
  categories,
  onClose,
}: {
  category?: Category;
  categories: Category[];
  onClose: () => void;
}) {
  const t = useTranslations("products.categories");
  const run = useRun();
  const save = useMutation(api.products.saveCategory);
  const formId = useId();
  const form = useZodForm(categorySchema, { name: category?.name ?? "", parentId: category?.parentId ?? "" });
  const submit = form.handleSubmit(async () => {
    const r = await run(
      () => save({ ...(category ? { categoryId: category._id } : {}), values: form.getValues() }),
      t("saved"),
    );
    if (r.ok) onClose();
  });
  // Parents: not itself or its descendants, and not at the deepest level.
  const parents = categories.filter(
    (c) =>
      depth(c) < MAX_CATEGORY_DEPTH &&
      (!category || (c._id !== category._id && !c.path.startsWith(`${category.path} > `))),
  );
  return (
    <FormDialog
      title={category ? t("editTitle") : t("addTitle")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
    >
      <TextField form={form} name="name" label={t("name")} required />
      <SelectField
        form={form}
        name="parentId"
        label={t("parent")}
        placeholder={t("parentNone")}
        options={parents.map((c) => ({ value: c._id, label: c.path }))}
      />
    </FormDialog>
  );
}

function DeleteDialog({ category, onClose }: { category: Category; onClose: () => void }) {
  const t = useTranslations("products.categories");
  const run = useRun();
  const remove = useMutation(api.products.deleteCategory);
  const [target, setTarget] = useState<"parent" | "none">(category.parentId ? "parent" : "none");
  const name = useId();
  const needsTarget = category.productCount > 0 || category.childCount > 0;
  return (
    <ConfirmDialog
      title={t("deleteTitle")}
      description={category.path}
      confirmLabel={t("delete")}
      destructive
      onClose={onClose}
      onConfirm={async () => {
        const r = await run(
          () => remove({ categoryId: category._id as Id<"productCategories">, ...(needsTarget ? { target } : {}) }),
          t("deleted"),
        );
        if (r.ok) onClose();
      }}
    >
      {needsTarget && (
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1 font-medium">{t("deleteTarget")}</legend>
          {(category.parentId ? (["parent", "none"] as const) : (["none"] as const)).map((x) => (
            <label key={x} className="flex min-h-11 items-center gap-2 md:min-h-8">
              <input
                type="radio"
                name={name}
                className="size-5 accent-primary md:size-4"
                checked={target === x}
                onChange={() => setTarget(x)}
              />
              {t(`targets.${x}`)}
            </label>
          ))}
        </fieldset>
      )}
    </ConfirmDialog>
  );
}
