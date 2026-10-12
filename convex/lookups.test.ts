import { describe, expect, test } from "vitest";
import { CASH_HELP_TEXT } from "../src/domain/lookups/payment-methods";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { patchCompanyProfile } from "./model/companyProfile";
import { seedSettingsDefaults } from "./model/seeds";
import { makeT, type TestT } from "./test.setup";

const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;

async function seeded(t: TestT) {
  const owner = await t.asUser("owner");
  await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) => seedSettingsDefaults(ctx));
  return owner;
}

describe("SET-090 SET-091 units", () => {
  test("SET-090 the seed list is stored as system units; custom units need a Rec 20/21 code", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const units = await owner.query(api.lookups.listUnits, {});
    expect(units).toHaveLength(35);
    expect(units.every((u) => u.isSystem)).toBe(true);
    expect(
      await owner
        .mutation(api.lookups.createUnit, { values: { code: "FOO", labelDe: "Foo", labelEn: "foo" } })
        .catch(reasonOf),
    ).toBe("UNIT_CODE_INVALID");
    expect(
      await owner
        .mutation(api.lookups.createUnit, { values: { code: "HUR", labelDe: "Std", labelEn: "h" } })
        .catch(reasonOf),
    ).toBe("UNIT_DUPLICATE");
    await owner.mutation(api.lookups.createUnit, {
      values: { code: "XPP", labelDe: "Palettenplatz", labelEn: "pallet place" },
    });
    expect((await owner.query(api.lookups.listUnits, {})).find((u) => u.code === "XPP")).toMatchObject({
      isSystem: false,
    });
  });

  test("SET-091 system units are archived, never deleted; labels stay editable; unused custom units can be deleted", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const units = await owner.query(api.lookups.listUnits, {});
    const hur = units.find((u) => u.code === "HUR");
    if (!hur) throw new Error("HUR missing");
    expect(await owner.mutation(api.lookups.deleteUnit, { unitId: hur.unitId }).catch(reasonOf)).toBe("UNIT_SYSTEM");
    await owner.mutation(api.lookups.updateUnit, {
      unitId: hur.unitId,
      values: { code: "HUR", labelDe: "Stunde(n)", labelEn: "hour(s)" },
    });
    await owner.mutation(api.lookups.archiveUnit, { unitId: hur.unitId, archived: true });
    expect((await owner.query(api.lookups.listUnits, {})).find((u) => u.code === "HUR")).toMatchObject({
      labelDe: "Stunde(n)",
      archivedAt: expect.any(Number),
    });
    const custom = (await owner.mutation(api.lookups.createUnit, {
      values: { code: "XPP", labelDe: "Palettenplatz", labelEn: "pallet place" },
    })) as Id<"units">;
    await owner.mutation(api.lookups.deleteUnit, { unitId: custom });
    expect((await owner.query(api.lookups.listUnits, {})).some((u) => u.code === "XPP")).toBe(false);
  });
});

describe("SET-092 SET-093 payment methods", () => {
  test("SET-092 seeded methods; SEPA-Lastschrift can only be activated with a creditor ID; one default", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const methods = await owner.query(api.lookups.listPaymentMethods, {});
    expect(methods.map((m) => m.name)).toEqual([
      "Überweisung",
      "SEPA-Lastschrift",
      "Barzahlung",
      "PayPal",
      "Kartenzahlung",
      "Sonstige",
    ]);
    const sepa = methods.find((m) => m.kind === "sepa_debit");
    if (!sepa) throw new Error("no sepa");
    const activate = () =>
      owner.mutation(api.lookups.savePaymentMethod, {
        paymentMethodId: sepa.paymentMethodId,
        values: { name: sepa.name, text: sepa.text, kind: "sepa_debit", isDefault: false, active: true },
      });
    expect(await activate().catch(reasonOf)).toBe("CREDITOR_ID_REQUIRED");
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      patchCompanyProfile(ctx, { creditorId: "DE98ZZZ09999999999" }, { action: "settings.company.update" }),
    );
    await activate();
    const card = methods.find((m) => m.kind === "card");
    if (!card) throw new Error("no card");
    await owner.mutation(api.lookups.savePaymentMethod, {
      paymentMethodId: card.paymentMethodId,
      values: { name: card.name, text: card.text, kind: "card", isDefault: true, active: true },
    });
    const after = await owner.query(api.lookups.listPaymentMethods, {});
    expect(after.filter((m) => m.isDefault).map((m) => m.kind)).toEqual(["card"]);
    expect(after.find((m) => m.kind === "sepa_debit")?.active).toBe(true);
  });

  test("SET-093 AO-04 the cash text may not imply a till receipt", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const cash = (await owner.query(api.lookups.listPaymentMethods, {})).find((m) => m.kind === "cash");
    if (!cash) throw new Error("no cash");
    expect(
      await owner
        .mutation(api.lookups.savePaymentMethod, {
          paymentMethodId: cash.paymentMethodId,
          values: {
            name: "Barzahlung",
            text: "Sie erhalten einen Kassenbon.",
            kind: "cash",
            isDefault: false,
            active: true,
          },
        })
        .catch(reasonOf),
    ).toBe("CASH_TEXT_TILL");
    expect(CASH_HELP_TEXT).toContain("Diese Software ist keine Kasse.");
  });
});

describe("SET-094 tags", () => {
  test("SET-094 unique case-insensitive names with a palette colour; deleting removes the tag", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const id = (await owner.mutation(api.lookups.saveTag, { values: { name: "Wichtig", color: "red" } })) as Id<"tags">;
    expect(await owner.mutation(api.lookups.saveTag, { values: { name: "wichtig" } }).catch(reasonOf)).toBe(
      "TAG_DUPLICATE",
    );
    await owner.mutation(api.lookups.saveTag, { tagId: id, values: { name: "Sehr wichtig", color: "orange" } });
    expect(await owner.query(api.lookups.listTags, {})).toEqual([
      { tagId: id, name: "Sehr wichtig", color: "orange", usage: 0 },
    ]);
    await owner.mutation(api.lookups.deleteTag, { tagId: id });
    expect(await owner.query(api.lookups.listTags, {})).toEqual([]);
  });
});

describe("SET-095 SET-096 custom fields", () => {
  const FIELD = {
    entity: "contact",
    key: "projekt",
    label: "Projekt",
    type: "text",
    options: "",
    printOnDocuments: true,
    required: false,
  };

  test("SET-095 definitions per entity with key rules and duplicates; the key is immutable", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const id = (await owner.mutation(api.lookups.createCustomField, { values: FIELD })) as Id<"customFieldDefs">;
    expect(await owner.mutation(api.lookups.createCustomField, { values: FIELD }).catch(reasonOf)).toBe(
      "CUSTOM_FIELD_DUPLICATE",
    );
    await owner.mutation(api.lookups.createCustomField, { values: { ...FIELD, entity: "document" } });
    expect(
      await owner
        .mutation(api.lookups.updateCustomField, { customFieldId: id, values: { ...FIELD, key: "projekt_neu" } })
        .catch(reasonOf),
    ).toBe("CUSTOM_FIELD_KEY_LOCKED");
    await owner.mutation(api.lookups.updateCustomField, {
      customFieldId: id,
      values: { ...FIELD, type: "select", options: "Intern\nExtern" },
    });
    expect((await owner.query(api.lookups.listCustomFields, {})).find((f) => f.customFieldId === id)).toMatchObject({
      type: "select",
      options: ["Intern", "Extern"],
    });
  });

  test("SET-096 SET-082 archiving hides the field; templates can no longer use its placeholder", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const id = (await owner.mutation(api.lookups.createCustomField, { values: FIELD })) as Id<"customFieldDefs">;
    const head = {
      kind: "document_head",
      docTypes: ["invoice"],
      language: "de",
      name: "K",
      body: "{{contact.custom.projekt}}",
      isDefault: false,
    };
    await owner.mutation(api.lookups.saveTextTemplate, { values: head });
    await owner.mutation(api.lookups.archiveCustomField, { customFieldId: id });
    expect(await owner.query(api.lookups.listCustomFields, {})).toEqual([]);
    expect(await owner.mutation(api.lookups.saveTextTemplate, { values: head }).catch(reasonOf)).toBe(
      "PLACEHOLDER_UNKNOWN",
    );
  });
});

describe("SET-097 cost centres", () => {
  test("SET-097 DATEV-02 unique numbers, one default, archive clears the default; > 8 characters warns", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const a = await owner.mutation(api.lookups.saveCostCenter, {
      values: { number: "100", name: "Vertrieb", isDefault: true },
    });
    expect(a.warnings).toEqual([]);
    const b = await owner.mutation(api.lookups.saveCostCenter, {
      values: { number: "PROJEKT2026", name: "Projekt", isDefault: true },
    });
    expect(b.warnings).toEqual(["Ältere DATEV-Versionen akzeptieren nur 8 Zeichen."]);
    expect(
      await owner
        .mutation(api.lookups.saveCostCenter, { values: { number: "100", name: "Doppelt", isDefault: false } })
        .catch(reasonOf),
    ).toBe("COST_CENTER_INVALID");
    let list = await owner.query(api.lookups.listCostCenters, {});
    expect(list.filter((c) => c.isDefault).map((c) => c.number)).toEqual(["PROJEKT2026"]);
    await owner.mutation(api.lookups.archiveCostCenter, { costCenterId: b.id });
    list = await owner.query(api.lookups.listCostCenters, {});
    expect(list.find((c) => c.number === "PROJEKT2026")).toMatchObject({
      isDefault: false,
      archivedAt: expect.any(Number),
    });
  });
});
