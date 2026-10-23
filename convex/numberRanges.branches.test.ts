import { describe, expect, test } from "vitest";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import {
  assignCounterNumber,
  continueRangeAfterImport,
  createRange,
  deactivateRange,
  deleteRange,
  registerDerivedNumber,
  registerEntryOf,
  registerView,
  saveRanges,
} from "./model/numberRanges";
import type { ModelCtx } from "./model/types";
import { makeT, type TestT } from "./test.setup";

/** Branch coverage of convex/model/numberRanges.ts (F01 SET-055…065, F09 IMP-005 / E-IMP-12, QUO-06). */

const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
const data = (e: unknown) => (e as { data?: { reason?: string; message?: string; number?: string } }).data ?? {};
async function fail(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return { code: errorCode(e), ...data(e) };
  }
  throw new Error("expected an error");
}

const ym = () => {
  const d = berlinCalendarDate(Date.now());
  return { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)) };
};
const YEAR = ym().year;

const INVOICE = { key: "invoice", name: "Rechnungen", format: "RE-{YYYY}-{####}", resetPolicy: "yearly", next: 1 };
const CONTACT = { key: "contact", name: "Kontakte", format: "{#####}", resetPolicy: "never", next: 10000 };
const PRODUCT = { key: "product", name: "Produkte", format: "P-{####}", resetPolicy: "never", next: 1 };

async function setup(t: TestT) {
  const owner = await t.asUser("owner");
  await owner.mutation(api.settings.saveNumberRanges, { values: { ranges: [INVOICE, CONTACT, PRODUCT] } });
  return owner;
}
const run = <T>(t: TestT, fn: (ctx: ModelCtx) => Promise<T>) => t.model(OWNER, fn);
const issue = (t: TestT, docType: string, documentId?: string) =>
  run(t, (ctx) =>
    assignCounterNumber(ctx, {
      docType,
      date: ym(),
      ...(documentId ? { documentId } : {}),
      action: "document.finalize",
    }),
  );
const defaultRange = (t: TestT, docType: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query("numberRanges").collect()).find((r) => r.isDefault && r.docTypes.includes(docType)),
  );

describe("saveRanges / createRange guards (SET-006, SET-055)", () => {
  test("SET-006 an unknown range key and an invalid format are refused in the model", async () => {
    const t = makeT();
    await setup(t);
    expect(
      await fail(run(t, (ctx) => saveRanges(ctx, { ranges: [{ ...INVOICE, key: "unknown" }] } as never, ym()))),
    ).toMatchObject({ code: "invalid_input", message: "Unbekannter Nummernkreis unknown." });
    const bad = await fail(
      run(t, (ctx) => saveRanges(ctx, { ranges: [{ ...INVOICE, format: "RE-ohne-Zaehler" }] } as never, ym())),
    );
    expect(bad.code).toBe("invalid_input");
    expect(bad.message).toMatch(/Zähler/);
  });

  test("SET-055 createRange refuses a format without a counter", async () => {
    const t = makeT();
    await setup(t);
    const e = await fail(
      run(t, (ctx) =>
        createRange(
          ctx,
          { name: "X", docTypes: ["invoice"], format: "X-{YYYY}", resetPolicy: "yearly", startValue: 1 },
          ym(),
        ),
      ),
    );
    expect(e.code).toBe("invalid_input");
  });

  test("SET-059 saving the unchanged values with a counter writes no counter change", async () => {
    const t = makeT();
    const owner = await setup(t);
    await issue(t, "invoice");
    await owner.mutation(api.settings.saveNumberRanges, { values: { ranges: [{ ...INVOICE, next: 2 }] } });
    const counterAudits = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter(
        (a) => a.entity.table === "numberCounters" && a.action === "settings.number_range.update",
      ),
    );
    expect(counterAudits).toEqual([]);
    const ranges = await owner.query(api.settings.listNumberRanges, {});
    expect(ranges.find((r) => r.docTypes.includes("invoice"))?.next).toBe(2);
  });

  test("SET-062 deactivate and delete of an unknown range → not_found", async () => {
    const t = makeT();
    await setup(t);
    const id = (await defaultRange(t, "product"))?._id as Id<"numberRanges">;
    await run(t, (ctx) =>
      createRange(
        ctx,
        { name: "P2", docTypes: ["product"], format: "Q-{####}", resetPolicy: "never", startValue: 1 },
        ym(),
      ),
    );
    // delete the default product range by direct removal → its id is now unknown
    await t.run(async (ctx) => {
      await ctx.db.delete(id);
    });
    expect((await fail(run(t, (ctx) => deactivateRange(ctx, id)))).code).toBe("not_found");
    expect((await fail(run(t, (ctx) => deleteRange(ctx, id)))).code).toBe("not_found");
  });
});

describe("continueRangeAfterImport (F09 IMP-005, F01 SET-065, EC-014)", () => {
  test("SET-065 IMP-005 continues an existing range: sets the counter, format and reset policy (audited „Import“)", async () => {
    const t = makeT();
    await setup(t);
    await run(t, (ctx) =>
      continueRangeAfterImport(
        ctx,
        { rangeKey: "invoice", format: "RE{YYYY}-{#####}", resetPolicy: "yearly", next: 120 },
        ym(),
      ),
    );
    const range = await defaultRange(t, "invoice");
    expect(range).toMatchObject({ format: "RE{YYYY}-{#####}", resetPolicy: "yearly" });
    const counters = await t.run((ctx) => ctx.db.query("numberCounters").collect());
    expect(counters).toMatchObject([{ rangeId: range?._id, periodKey: String(YEAR), next: 120 }]);
    // a second import run patches the existing counter
    await run(t, (ctx) =>
      continueRangeAfterImport(
        ctx,
        { rangeKey: "invoice", format: "RE{YYYY}-{#####}", resetPolicy: "yearly", next: 130 },
        ym(),
      ),
    );
    expect((await t.run((ctx) => ctx.db.query("numberCounters").collect()))[0]?.next).toBe(130);
    const reasons = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect())
        .filter((a) => a.action === "settings.number_range.update")
        .map((a) => a.reason),
    );
    expect(reasons).toContain("Import (Fortsetzung der sevdesk-Nummern)");
    expect(await issue(t, "invoice")).toMatchObject({ number: `RE${YEAR}-00130` });
  });

  test("SET-065 a range without a default is created with the imported format", async () => {
    const t = makeT();
    await setup(t);
    await run(t, (ctx) =>
      continueRangeAfterImport(ctx, { rangeKey: "quote", format: "AN-{####}", resetPolicy: "never", next: 57 }, ym()),
    );
    const range = await defaultRange(t, "quote");
    expect(range).toMatchObject({ format: "AN-{####}", startValue: 57, isDefault: true, active: true });
  });

  test("E-IMP-12 IMP-005 unknown key, invalid format, invalid next, a colliding next number and a lower next are refused", async () => {
    const t = makeT();
    await setup(t);
    const go = (input: {
      rangeKey: string;
      format: string;
      resetPolicy: "never" | "yearly" | "monthly";
      next: number;
    }) => fail(run(t, (ctx) => continueRangeAfterImport(ctx, input, ym())));
    expect(await go({ rangeKey: "nope", format: "X-{####}", resetPolicy: "never", next: 1 })).toMatchObject({
      message: "Unbekannter Nummernkreis nope.",
    });
    expect((await go({ rangeKey: "invoice", format: "X", resetPolicy: "never", next: 1 })).code).toBe("invalid_input");
    expect(await go({ rangeKey: "invoice", format: "X-{####}", resetPolicy: "never", next: 0 })).toMatchObject({
      message: "Ungültige nächste Nummer.",
    });
    expect(await go({ rangeKey: "invoice", format: "X-{####}", resetPolicy: "never", next: 1.5 })).toMatchObject({
      message: "Ungültige nächste Nummer.",
    });
    // issue RE-<year>-0001 and -0002, then propose to continue at 1 → collision with the register
    await issue(t, "invoice");
    await issue(t, "invoice");
    expect(await go({ rangeKey: "invoice", format: INVOICE.format, resetPolicy: "yearly", next: 1 })).toEqual({
      code: "invalid_input",
      reason: "E_IMP_12",
      number: `RE-${YEAR}-0001`,
      message: `Die nächste Nummer RE-${YEAR}-0001 wäre nicht eindeutig.`,
    });
    // a different format (no collision) but below the counter → SET-059
    const lower = await go({ rangeKey: "invoice", format: "R-{YYYY}-{####}", resetPolicy: "yearly", next: 2 });
    expect(lower).toMatchObject({ code: "invalid_input", reason: "COUNTER_DECREASE" });
  });
});

describe("assignCounterNumber / registerDerivedNumber (SET-064, QUO-06, RI-02)", () => {
  test("RI-02 SET-064 a counter value whose number is already in the register → NUMBER_COLLISION", async () => {
    const t = makeT();
    await setup(t);
    await run(t, (ctx) =>
      registerDerivedNumber(ctx, { number: "P-0001", docType: "product", documentId: "x", action: "product.create" }),
    );
    const e = await fail(issue(t, "product"));
    expect(e).toMatchObject({
      code: "conflict",
      reason: "NUMBER_COLLISION",
      message: "Die Nummer P-0001 ist bereits vergeben. Bitte den Nummernkreis prüfen.",
    });
  });

  test("QUO-06 a derived revision number is registered once; a second registration → NUMBER_COLLISION", async () => {
    const t = makeT();
    await setup(t);
    const { rangeId } = await issue(t, "invoice", "doc-1");
    await run(t, (ctx) =>
      registerDerivedNumber(ctx, {
        number: `RE-${YEAR}-0001-V2`,
        rangeId,
        docType: "invoice",
        documentId: "doc-2",
        action: "document.finalize",
      }),
    );
    const rows = await t.run((ctx) => ctx.db.query("numberRegister").collect());
    expect(rows.find((r) => r.number.endsWith("-V2"))).toMatchObject({ rangeId, status: "issued" });
    expect(rows.find((r) => r.number.endsWith("-V2"))?.counter).toBeUndefined();
    const e = await fail(
      run(t, (ctx) =>
        registerDerivedNumber(ctx, {
          number: `re-${YEAR}-0001-v2`,
          docType: "invoice",
          documentId: "doc-3",
          action: "document.finalize",
        }),
      ),
    );
    expect(e).toMatchObject({ code: "conflict", reason: "NUMBER_COLLISION" });
  });
});

describe("registerView / registerEntryOf (SET-063, DOC-39)", () => {
  test("SET-063 filters by period and status, links contacts, products and sales documents", async () => {
    const t = makeT();
    await setup(t);
    await issue(t, "contact", "c1");
    await issue(t, "contact"); // no document id → no link
    await issue(t, "product", "p1");
    await issue(t, "invoice", "inv1");
    const contactRange = (await defaultRange(t, "contact"))?._id as Id<"numberRanges">;
    const productRange = (await defaultRange(t, "product"))?._id as Id<"numberRanges">;
    const invoiceRange = (await defaultRange(t, "invoice"))?._id as Id<"numberRanges">;

    const contacts = await t.run((ctx) => registerView(ctx, { rangeId: contactRange }));
    expect(contacts.rows.map((r) => [r.number, r.link])).toEqual([
      ["10001", null],
      ["10000", "/kontakte/c1"],
    ]);
    expect(contacts.periods).toEqual([]); // reset policy never → empty period key
    expect(contacts.truncated).toBe(false);

    const products = await t.run((ctx) => registerView(ctx, { rangeId: productRange, status: "issued" }));
    expect(products.rows.map((r) => r.link)).toEqual(["/produkte/p1"]);
    const none = await t.run((ctx) => registerView(ctx, { rangeId: productRange, status: "corrected" }));
    expect(none.rows).toEqual([]);

    const inv = await t.run((ctx) => registerView(ctx, { rangeId: invoiceRange, periodKey: String(YEAR) }));
    expect(inv.periods).toEqual([String(YEAR)]);
    expect(inv.rows[0]?.link).toMatch(/inv1$/);
    const other = await t.run((ctx) => registerView(ctx, { rangeId: invoiceRange, periodKey: "1999" }));
    expect(other.rows).toEqual([]);
  });

  test("SET-063 an unknown range → not_found; a register row of another doc type has no link", async () => {
    const t = makeT();
    await setup(t);
    const productRange = (await defaultRange(t, "product"))?._id as Id<"numberRanges">;
    await run(t, (ctx) =>
      registerDerivedNumber(ctx, {
        number: "P-9999",
        rangeId: productRange,
        docType: "asset",
        documentId: "a1",
        action: "asset.create",
      }),
    );
    const v = await t.run((ctx) => registerView(ctx, { rangeId: productRange }));
    expect(v.rows).toMatchObject([{ number: "P-9999", link: null, counter: null, periodKey: null }]);
    await t.run(async (ctx) => {
      await ctx.db.delete(productRange);
    });
    expect((await fail(t.run((ctx) => registerView(ctx, { rangeId: productRange })))).code).toBe("not_found");
  });

  test("DOC-39 registerEntryOf: unknown number → null; a derived number without range has no range name", async () => {
    const t = makeT();
    await setup(t);
    expect(await t.run((ctx) => registerEntryOf(ctx, "XX-1"))).toBeNull();
    await run(t, (ctx) =>
      registerDerivedNumber(ctx, { number: "AN-7-V2", docType: "quote", documentId: "q", action: "document.finalize" }),
    );
    expect(await t.run((ctx) => registerEntryOf(ctx, "an-7-v2"))).toMatchObject({
      number: "AN-7-V2",
      rangeId: null,
      rangeName: null,
      periodKey: null,
      imported: false,
    });
  });
});
