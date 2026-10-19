import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { dunningSetup, markSent } from "./dunning.fixtures";
import { b2bBuyer, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import type { TestT } from "./test.setup";
import { makeT } from "./test.setup";

/** F01 SET-120…123 owner rule overrides: add, precedence at finalisation and in dunning, lock and deletion. */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

type Owner = Awaited<ReturnType<typeof setupInvoicing>>["owner"];

const addOverride = (owner: Owner, values: Record<string, unknown>) =>
  owner.mutation(api.settings.addRuleOverride, { values });

const snapshotVersions = (t: TestT, documentId: Id<"salesDocuments">) =>
  t.run(
    async (ctx) =>
      (
        await ctx.db
          .query("documentSnapshots")
          .withIndex("by_document", (q) => q.eq("documentId", documentId))
          .first()
      )?.ruleVersions ?? {},
  );

describe("SET-120 … SET-123 rule overrides", { timeout: 60_000 }, () => {
  test("SET-121 SET-122 a tax rate override wins in the draft; a rate without account role blocks the posting, not silently", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const bad = await catching(
      addOverride(owner, { ruleSet: "taxRate", tableId: "luxury", validFrom: "2026-01-01", rate: "25", source: "x" }),
    );
    expect(dataOf(bad)).toMatchObject({
      reason: "RULE_KEY_UNKNOWN",
      message: "Unbekannter Steuersatz-Schlüssel luxury.",
    });
    const noSource = await catching(
      addOverride(owner, { ruleSet: "taxRate", tableId: "standard", validFrom: "2026-01-01", rate: "20", source: "" }),
    );
    expect(JSON.stringify(dataOf(noSource))).toContain("Bitte eine Quelle angeben");

    const { id: overrideId, warnings } = await addOverride(owner, {
      ruleSet: "taxRate",
      tableId: "standard",
      validFrom: "2026-10-01",
      validTo: "2026-12-31",
      rate: "20",
      source: "Testgesetz 2026 (BGBl. 2026 I Nr. 1)",
    });
    expect(warnings).toEqual([
      "Für den Steuersatz 20 % gibt es keine Kontenrolle. Rechnungen mit diesem Satz können erst nach einem Update gebucht und daher nicht fertiggestellt werden.",
    ]);
    const overlapping = await catching(
      addOverride(owner, { ruleSet: "taxRate", tableId: "standard", validFrom: "2026-12-01", rate: "21", source: "x" }),
    );
    expect(dataOf(overlapping).reason).toBe("RULE_OVERLAP");

    const overview = await owner.query(api.settings.ruleOverview, {});
    const standard = overview.tables.find((x) => x.id === "standard");
    expect(standard?.rows.find((r) => r.current)).toMatchObject({ origin: "override", value: "20 % (S)" });
    expect(overview.overrides).toEqual([expect.objectContaining({ id: overrideId, locked: false })]);

    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    expect((await t.run((ctx) => ctx.db.get(id)))?.totals).toMatchObject({ netCents: 100_000, grossCents: 120_000 });
    const refused = await catching(owner.action(api.invoices.finalize, { id, version: 1 }));
    expect(dataOf(refused)).toMatchObject({ code: "posting_rejected", reason: "rate_not_supported" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("draft");
    // Unreferenced: may be deleted, with a reason in the audit trail (SET-123).
    await owner.mutation(api.settings.deleteRuleOverride, { id: overrideId, reason: "Satz gilt doch nicht" });
    expect(await t.run((ctx) => ctx.db.query("ruleOverrides").collect())).toEqual([]);
  });

  test("SET-121 SET-122 SET-123 a note text override is printed, recorded in the snapshot and then locked; deletions are audited", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t, { seller: "ku" });
    const ku = {
      ruleSet: "noteText",
      tableId: "ku_note_19",
      de: "Gemäß § 19 Abs. 1 UStG wird keine Umsatzsteuer berechnet.",
      en: "No VAT is charged under Section 19 (1) UStG.",
    };
    const { id: overrideId } = await addOverride(owner, {
      ...ku,
      validFrom: "2026-01-01",
      validTo: "2026-12-31",
      source: "Eigene Formulierung (SET-036)",
    });
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const snapshot = await t.run(async (ctx) =>
      ctx.db
        .query("documentSnapshots")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .first(),
    );
    expect(snapshot?.ruleVersions["note:ku_note_19"]).toBe(`override:${overrideId}`);
    expect(snapshot?.json).toContain("Gemäß § 19 Abs. 1 UStG wird keine Umsatzsteuer berechnet.");

    expect((await owner.query(api.settings.ruleOverview, {})).overrides[0]?.locked).toBe(true);
    const locked = await catching(
      owner.mutation(api.settings.deleteRuleOverride, { id: overrideId, reason: "Fehler korrigieren" }),
    );
    expect(dataOf(locked)).toMatchObject({
      reason: "RULE_ROW_LOCKED",
      message:
        "Diese Regel wurde bereits in fertiggestellten Dokumenten verwendet. Bitte eine neue Zeile mit neuem Gültigkeitsdatum anlegen.",
    });
    // Correction = a new row with a new validity date.
    const { id: next } = await addOverride(owner, { ...ku, validFrom: "2027-01-01", source: "Neue Formulierung" });
    await owner.mutation(api.settings.deleteRuleOverride, { id: next, reason: "Doch nicht benötigt" });
    const rows = await t.run((ctx) => ctx.db.query("ruleOverrides").collect());
    expect(rows.map((r) => r._id)).toEqual([overrideId]);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.filter((a) => a.action.startsWith("rule_override.")).map((a) => [a.action, a.reason])).toEqual([
      ["rule_override.add", "Eigene Formulierung (SET-036)"],
      ["rule_override.add", "Neue Formulierung"],
      ["rule_override.delete", "Doch nicht benötigt"],
    ]);
  });

  test("SET-122 SET-123 T-SET-058 a Basiszinssatz override drives the reminder interest, is recorded in the reminder and is then locked", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    // L1 on 2026-10-19, sent by post (Zugang 2026-10-22); L2 on 2026-11-05 charges interest from 2026-10-27.
    vi.setSystemTime(new Date("2026-10-19T08:00:00Z"));
    let owner = await t.asUser("owner", { existingUserId: s.owner.userId });
    const { id: l1 } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    await owner.mutation(api.dunning.finalize, { id: l1 as Id<"salesDocuments"> });
    await settle(t);
    await markSent(owner, l1 as Id<"salesDocuments">, "2026-10-19", "post");
    vi.setSystemTime(new Date("2026-11-05T08:00:00Z"));
    owner = await t.asUser("owner", { existingUserId: s.owner.userId });
    const shipped = (await owner.query(api.dunning.preview, {})).actions[0]?.claim?.interestCents;
    expect(shipped).toBe(343);

    const { id: overrideId, warnings } = await addOverride(owner, {
      ruleSet: "basiszinssatz",
      tableId: "basiszinssatz",
      validFrom: "2026-07-01",
      rate: "5",
      source: "Testmitteilung der Bundesbank",
    });
    expect(warnings).toEqual([]);
    // 1.190,00 € × (5 % + 9 Punkte) × 10 Tage / 365 = 4,56 €
    expect((await owner.query(api.dunning.preview, {})).actions[0]?.claim?.interestCents).toBe(456);
    const calc = await owner.query(api.dunning.interest, {
      values: { amountCents: 119_000, from: "2026-10-27", to: "2026-11-05", margin: "b2b" },
    });
    expect(calc.segments[0]?.basiszinsRowId).toBe(`override:${overrideId}`);

    const { id: l2 } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    await owner.mutation(api.dunning.finalize, { id: l2 as Id<"salesDocuments"> });
    expect(await snapshotVersions(t, l2 as Id<"salesDocuments">)).toMatchObject({
      "basiszins:2026-10-27": `override:${overrideId}`,
    });
    const locked = await catching(
      owner.mutation(api.settings.deleteRuleOverride, { id: overrideId, reason: "Satz war falsch" }),
    );
    expect(dataOf(locked).reason).toBe("RULE_ROW_LOCKED");
    // The locked open-ended row is corrected by a new row: it ends the day before the new row starts.
    await addOverride(owner, {
      ruleSet: "basiszinssatz",
      tableId: "basiszinssatz",
      validFrom: "2027-01-01",
      rate: "4,5",
      source: "Folgemitteilung der Bundesbank",
    });
    const basis = (await owner.query(api.settings.ruleOverview, {})).tables.find((x) => x.id === "basiszinssatz");
    expect(basis?.rows.filter((r) => r.origin === "override").map((r) => [r.validFrom, r.validTo])).toEqual([
      ["2026-07-01", "2026-12-31"],
      ["2027-01-01", undefined],
    ]);
  });
});
