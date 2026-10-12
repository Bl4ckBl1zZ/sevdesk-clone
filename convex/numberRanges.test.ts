import { describe, expect, test } from "vitest";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import { assignCounterNumber } from "./model/numberRanges";
import { makeT, type TestT } from "./test.setup";

const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;
const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message;

const today = () => {
  const d = berlinCalendarDate(Date.now());
  return { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)) };
};
const YEAR = today().year;

const INVOICE = { key: "invoice", name: "Rechnungen", format: "RE-{YYYY}-{####}", resetPolicy: "yearly", next: 1 };
const CONTACT = { key: "contact", name: "Kontakte", format: "{#####}", resetPolicy: "never", next: 10000 };

async function setup(t: TestT) {
  const owner = await t.asUser("owner");
  await owner.mutation(api.settings.saveNumberRanges, { values: { ranges: [INVOICE, CONTACT] } });
  return owner;
}

/** Issues `n` numbers of `docType` like the finalisation (P1) / contact creation will (SET-061/064). */
async function issue(t: TestT, docType: string, n: number) {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await t.model({ actor: "user:test-owner", role: "owner", channel: "ui" }, (ctx) =>
      assignCounterNumber(ctx, { docType, date: today(), documentId: `doc-${i}`, action: "document.finalize" }),
    );
    out.push(r.number);
  }
  return out;
}

const rangeOf = async (owner: Awaited<ReturnType<typeof setup>>, docType: string) =>
  (await owner.query(api.settings.listNumberRanges, {})).find((r) => r.isDefault && r.docTypes.includes(docType));

describe("SET-059 „Nächste Nummer“ only goes up (UST-06, GOBD-02)", () => {
  test("SET-059 T-SET-034 lowering → COUNTER_DECREASE; raising without reason → REASON_REQUIRED; with reason the gap is audited", async () => {
    const t = makeT();
    const owner = await setup(t);
    await issue(t, "invoice", 41);
    expect((await rangeOf(owner, "invoice"))?.next).toBe(42);

    const lower = await owner
      .mutation(api.settings.saveNumberRanges, { values: { ranges: [{ ...INVOICE, next: 40 }] } })
      .catch((e: unknown) => e);
    expect(reasonOf(lower)).toBe("COUNTER_DECREASE");
    expect(messageOf(lower)).toBe(
      "Die nächste Nummer kann nicht unter 42 gesetzt werden, weil Nummern nie doppelt vergeben werden dürfen.",
    );
    expect(
      await owner
        .mutation(api.settings.saveNumberRanges, { values: { ranges: [{ ...INVOICE, next: 50 }] } })
        .catch(reasonOf),
    ).toBe("REASON_REQUIRED");

    await owner.mutation(api.settings.saveNumberRanges, {
      values: { ranges: [{ ...INVOICE, next: 50 }], reason: "Nummern im Altsystem verbraucht" },
    });
    expect((await rangeOf(owner, "invoice"))?.next).toBe(50);
    const entry = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).find((e) => e.entity.table === "numberCounters" && e.reason),
    );
    expect(entry).toMatchObject({
      action: "settings.number_range.update",
      reason: "Nummern im Altsystem verbraucht (Lücke 42–49)",
      diff: { before: { next: 42 }, after: { next: 50 } },
    });
  });
});

describe("SET-060 format changes are simulated against the register (EC-008)", () => {
  test("SET-060 T-SET-033 a new range whose numbers collide with issued ones is rejected with the colliding number", async () => {
    const t = makeT();
    const owner = await setup(t);
    await issue(t, "invoice", 3);
    const err = await owner
      .mutation(api.settings.createNumberRange, {
        values: {
          name: "Storno",
          docTypes: ["cancellation"],
          format: "re-{YYYY}-{####}",
          resetPolicy: "yearly",
          startValue: 1,
        },
      })
      .catch((e: unknown) => e);
    expect(reasonOf(err)).toBe("FORMAT_COLLISION");
    expect(messageOf(err)).toBe(
      `Das Format erzeugt die bereits vergebene Nummer re-${YEAR}-0001. Bitte Präfix oder Startwert ändern.`,
    );
    await owner.mutation(api.settings.createNumberRange, {
      values: {
        name: "Storno",
        docTypes: ["cancellation"],
        format: "ST-{YYYY}-{####}",
        resetPolicy: "yearly",
        startValue: 1,
      },
    });
  });

  test("SET-060 T-SET-083 SET-E16 yearly → never with next 1 re-creates issued numbers → FORMAT_COLLISION; next 3 is saved", async () => {
    const t = makeT();
    const owner = await setup(t);
    await issue(t, "invoice", 2); // RE-<year>-0001, RE-<year>-0002 in period "<year>"
    // The period key changes from "<year>" to "" (no counter yet), so the owner must continue above the issued numbers.
    expect(
      await owner
        .mutation(api.settings.saveNumberRanges, {
          values: { ranges: [{ ...INVOICE, resetPolicy: "never", next: 1 }] },
        })
        .catch(reasonOf),
    ).toBe("FORMAT_COLLISION");
    await owner.mutation(api.settings.saveNumberRanges, {
      values: { ranges: [{ ...INVOICE, resetPolicy: "never", next: 3 }] },
    });
    expect((await rangeOf(owner, "invoice"))?.resetPolicy).toBe("never");
    // The register keeps every issued number unchanged (nothing is renumbered).
    const numbers = await t.run(async (ctx) => (await ctx.db.query("numberRegister").collect()).map((r) => r.number));
    expect(numbers).toEqual([`RE-${YEAR}-0001`, `RE-${YEAR}-0002`]);
  });
});

describe("SET-062 used ranges cannot be deleted (GOBD-02)", () => {
  test("SET-062 T-SET-038 deleting a used range → RANGE_IN_USE; deactivating the only default → RANGE_DEFAULT_REQUIRED", async () => {
    const t = makeT();
    const owner = await setup(t);
    await issue(t, "invoice", 1);
    const invoice = await rangeOf(owner, "invoice");
    if (!invoice) throw new Error("no range");
    expect(invoice.inUse).toBe(true);
    expect(await owner.mutation(api.settings.deleteNumberRange, { rangeId: invoice.rangeId }).catch(reasonOf)).toBe(
      "RANGE_IN_USE",
    );
    const err = await owner
      .mutation(api.settings.deactivateNumberRange, { rangeId: invoice.rangeId })
      .catch((e: unknown) => e);
    expect(reasonOf(err)).toBe("RANGE_DEFAULT_REQUIRED");
    expect(messageOf(err)).toBe("Für Rechnung muss ein aktiver Standard-Nummernkreis existieren.");
  });

  test("SET-062 an unused extra range can be deleted; a deactivated range is never the default", async () => {
    const t = makeT();
    const owner = await setup(t);
    const extra = (await owner.mutation(api.settings.createNumberRange, {
      values: {
        name: "Projekte A",
        docTypes: ["invoice"],
        format: "PA-{YYYY}-{###}",
        resetPolicy: "yearly",
        startValue: 1,
      },
    })) as Id<"numberRanges">;
    await owner.mutation(api.settings.deactivateNumberRange, { rangeId: extra });
    const row = (await owner.query(api.settings.listNumberRanges, {})).find((r) => r.rangeId === extra);
    expect(row).toMatchObject({ active: false, isDefault: false });
    await owner.mutation(api.settings.deleteNumberRange, { rangeId: extra });
    expect((await owner.query(api.settings.listNumberRanges, {})).some((r) => r.rangeId === extra)).toBe(false);
    const actions = await t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).map((e) => e.action));
    expect(actions).toEqual(
      expect.arrayContaining(["settings.number_range.deactivate", "settings.number_range.delete"]),
    );
  });

  test("SET-062 only the owner manages ranges (bookkeeper → forbidden_role)", async () => {
    const t = makeT();
    const owner = await setup(t);
    const bookkeeper = await t.asUser("bookkeeper");
    const invoice = await rangeOf(owner, "invoice");
    if (!invoice) throw new Error("no range");
    expect(
      await bookkeeper.mutation(api.settings.deleteNumberRange, { rangeId: invoice.rangeId }).catch(errorCode),
    ).toBe("forbidden_role");
  });
});

describe("SET-064 contact, product, asset and internal-voucher numbers (GOBD-05)", () => {
  test("SET-064 contact numbers are assigned from the same mechanism: 10000, 10001 … with register rows", async () => {
    const t = makeT();
    await setup(t);
    expect(await issue(t, "contact", 2)).toEqual(["10000", "10001"]);
    const rows = await t.run((ctx) => ctx.db.query("numberRegister").collect());
    expect(rows.map((r) => [r.docType, r.number, r.status, r.counter])).toEqual([
      ["contact", "10000", "issued", 10000],
      ["contact", "10001", "issued", 10001],
    ]);
  });

  test("SET-064 a type without an active default range cannot get a number", async () => {
    const t = makeT();
    await setup(t);
    const err = await t
      .model({ actor: "user:test-owner", role: "owner", channel: "ui" }, (ctx) =>
        assignCounterNumber(ctx, { docType: "asset", date: today(), action: "asset.create" }),
      )
      .catch((e: unknown) => e);
    expect(reasonOf(err)).toBe("RANGE_DEFAULT_REQUIRED");
  });

  test("SET-064 GOBD-02 register rows are immutable except the allowed status transitions", async () => {
    const t = makeT();
    await setup(t);
    await issue(t, "contact", 1);
    const err = await t
      .model({ actor: "user:test-owner", role: "owner", channel: "ui" }, async (ctx) => {
        const row = await ctx.db.query("numberRegister").first();
        if (row) await ctx.db.patch("numberRegister", row._id, { number: "99999" });
      })
      .catch(errorCode);
    expect(err).toBe("immutable_record");
  });
});
