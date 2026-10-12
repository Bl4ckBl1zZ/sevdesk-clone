import { expect, test } from "vitest";
import { checkSource } from "./boundaries";

const rules = (file: string, src: string) => checkSource(file, src).map((v) => v.rule);

test("SMOKE ctx.db writes are rejected outside convex/model/** and convex/betterAuth/**", () => {
  const write = "export const f = async (ctx) => { await ctx.db.patch(id, { a: 1 }); };";
  expect(rules("convex/invoices.ts", write)).toEqual(["db-write-outside-model"]);
  expect(rules("convex/actions/pdf.ts", "const { db } = ctx; db.insert('x', {});")).toEqual(["db-write-outside-model"]);
  expect(rules("convex/model/invoices.ts", write)).toEqual([]);
  expect(rules("convex/betterAuth/adapter.ts", write)).toEqual([]);
  expect(rules("convex/invoices.test.ts", write)).toEqual([]);
  expect(rules("convex/invoices.ts", "// ctx.db.delete(id) is forbidden here\nctx.db.get(id);")).toEqual([]);
});

test("SMOKE src/domain stays pure: no React, Next, Convex, Node I/O or outside imports", () => {
  expect(rules("src/domain/money/x.ts", 'import { useState } from "react";')).toEqual(["domain-purity"]);
  expect(rules("src/domain/money/x.ts", 'import type { Id } from "convex/values";')).toEqual(["domain-purity"]);
  expect(rules("src/domain/money/x.ts", 'import { readFileSync } from "node:fs";')).toEqual(["domain-purity"]);
  expect(rules("src/domain/money/x.ts", 'import { api } from "../../../convex/_generated/api";')).toEqual([
    "domain-purity",
  ]);
  expect(rules("src/domain/money/x.ts", 'import { cn } from "@/lib/utils";')).toEqual(["domain-purity"]);
  expect(rules("src/domain/money/x.ts", 'import { round } from "../money/round";\nimport { z } from "zod";')).toEqual(
    [],
  );
  expect(rules("src/domain/money/x.test.ts", 'import { readFileSync } from "node:fs";')).toEqual([]);
});

test("SMOKE src/domain is deterministic: no clock, randomness, fetch or env", () => {
  expect(rules("src/domain/tax/x.ts", "const d = new Date();")).toEqual(["domain-determinism"]);
  expect(rules("src/domain/tax/x.ts", "const t = Date.now();")).toEqual(["domain-determinism"]);
  expect(rules("src/domain/tax/x.ts", 'const d = new Date(today + "T00:00:00Z");')).toEqual([]);
  expect(rules("src/domain/tax/x.ts", "const r = process.env.X;")).toEqual(["domain-determinism"]);
});

test("SMOKE src/** may import only convex/_generated; convex/** only src/domain, src/pdf, src/emails", () => {
  expect(rules("src/app/page.tsx", 'import { api } from "@convex/_generated/api";')).toEqual([]);
  expect(rules("src/app/page.tsx", 'import { useQuery } from "convex/react";')).toEqual([]);
  expect(rules("src/app/page.tsx", 'import { x } from "@convex/model/invoices";')).toEqual(["src-imports-convex"]);
  expect(rules("convex/invoices.ts", 'import { totals } from "../src/domain/documents/totals";')).toEqual([]);
  expect(rules("convex/invoices.ts", 'import { totals } from "@/domain/documents/totals";')).toEqual([]);
  expect(rules("convex/invoices.ts", 'import { Button } from "@/components/ui/button";')).toEqual([
    "convex-imports-src",
  ]);
});
