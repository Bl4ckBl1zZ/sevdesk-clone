import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { b2bBuyer, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { makeT, type TestT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};

const snapshotOf = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => {
    const d = await ctx.db.get(id);
    const s = d?.snapshotId ? await ctx.db.get(d.snapshotId) : null;
    return s ? (JSON.parse(s.json) as DocumentSnapshot) : null;
  });

const versionOf = (t: TestT, layoutId: Id<"layouts">) =>
  t.run(async (ctx) => (await ctx.db.get(layoutId))?.currentVersionId as string | undefined);

describe("DOC-54 layout per document", { timeout: 30_000 }, () => {
  test("DOC-54 SET-074 a draft's own layout, else the type's default, is frozen as the layout version", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const variant = (await owner.mutation(api.settings.createLayoutVariant, {
      values: { name: "Messe" },
    })) as Id<"layouts">;
    const variantVersion = await versionOf(t, variant);
    expect(variantVersion).toBeDefined();

    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: { ...invoiceValues(personId), layoutId: variant },
    });
    const draft = (await owner.query(api.invoices.get, { id })) as { values?: unknown } | null;
    expect(draft?.values).toMatchObject({ layoutId: variant });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    expect((await snapshotOf(t, id))?.layoutVersionId).toBe(variantVersion);

    // Without a choice the invoice uses its type default (not the variant).
    const plain = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id: plain.id, version: 1 });
    await settle(t);
    expect((await snapshotOf(t, plain.id))?.layoutVersionId).not.toBe(variantVersion);

    // The variant becomes the default for invoices → a new draft without a choice uses it.
    await owner.mutation(api.settings.setLayoutDefaults, { layoutId: variant, docTypes: ["invoice"] });
    const third = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id: third.id, version: 1 });
    await settle(t);
    expect((await snapshotOf(t, third.id))?.layoutVersionId).toBe(variantVersion);

    const unknown = await owner
      .mutation(api.invoices.createDraft, { values: { ...invoiceValues(personId), layoutId: "nope" } })
      .catch((x: unknown) => x);
    expect(dataOf(unknown).reason).toBe("LAYOUT_UNKNOWN");
  });
});

describe("SET-083 placeholders in line texts", { timeout: 30_000 }, () => {
  test("SET-083 line names and descriptions resolve placeholders at finalisation; plain names stay untouched", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const base = invoiceValues(personId);
    const item = base.lines[0];
    if (item?.kind !== "item") throw new Error("item line expected");
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: {
        ...base,
        lines: [
          { ...item, name: "Wartung {{date.year}} für {{contact.name}}", description: "Vertrag {{document.number}}" },
          { ...item, name: "Kabel <5 m & Stecker", description: "ohne Platzhalter" },
        ],
      },
    });
    const r = await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const snap = await snapshotOf(t, id);
    const items = (snap?.lines ?? []).filter((l) => l.kind === "item") as { name: string; description?: string }[];
    expect(items[0]?.name).toBe(`Wartung 2026 für ${snap?.buyer.name}`);
    expect(items[0]?.description).toBe(`Vertrag ${r.number}`);
    expect(items[1]?.name).toBe("Kabel <5 m & Stecker");
    // The stored draft line keeps the template (not stored resolved).
    const lines = await t.run((ctx) =>
      ctx.db
        .query("documentLines")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect(),
    );
    expect(lines.find((l) => l.position === 1)?.name).toBe("Wartung {{date.year}} für {{contact.name}}");
  });
});
