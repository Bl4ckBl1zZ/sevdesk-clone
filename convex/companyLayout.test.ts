import { describe, expect, test } from "vitest";
import { type CompanyValues, companyDefaults } from "../src/domain/schemas/settings";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import { patchCompanyProfile } from "./model/companyProfile";
import { deleteUnreferencedFile, fileReferences } from "./model/files";
import { makeT, type TestT } from "./test.setup";

const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;

const COMPANY: CompanyValues = {
  ...companyDefaults,
  legalForm: "gmbh",
  name: "Muster Design GmbH",
  street: "Hauptstr. 1",
  postalCode: "10115",
  city: "Berlin",
  seat: "Berlin",
  contactName: "Erika Musterfrau",
  phone: "+49 30 123456",
  email: "info@muster.de",
  registerCourt: "Amtsgericht Charlottenburg",
  registerNumber: "123456 B",
  representatives: [{ name: "Max Mustermann" }],
};
const BANK = {
  iban: "DE89 3704 0044 0532 0130 00",
  bic: "COBADEFFXXX",
  accountHolder: "Muster Design GmbH",
  currency: "EUR",
};
const LAYOUT = { template: "classic", accentColor: "#1F6FEB" };

async function storePng(t: TestT, label: string): Promise<Id<"_storage">> {
  return t.run((ctx) =>
    ctx.storage.store(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), label], { type: "image/png" })),
  );
}

describe("SET-020 company changes never alter finalised documents", () => {
  test("SET-020 T-SET-010 a later change leaves earlier companyProfileVersions untouched and reports the affected drafts", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveCompanyProfile, { values: COMPANY });
    const v1 = await t.run((ctx) => ctx.db.query("companyProfileVersions").first());
    await owner.mutation(api.settings.saveCompanyProfile, { values: { ...COMPANY, street: "Neue Str. 2" } });
    const versions = await t.run((ctx) => ctx.db.query("companyProfileVersions").collect());
    expect(versions).toHaveLength(2);
    expect(versions[0]).toEqual(v1);
    expect(JSON.parse(versions[0]?.profile ?? "{}").address.street).toBe("Hauptstr. 1");
    expect(JSON.parse(versions[1]?.profile ?? "{}").address.street).toBe("Neue Str. 2");
    // Sales documents (and drafts) arrive in P1: no draft can pick up the change yet.
    expect(await owner.query(api.settings.companyChangeImpact, {})).toEqual({ drafts: 0 });
  });
});

describe("SET-023 files referenced by snapshots are never deleted (GOBD-06, GOBD-20)", () => {
  test("SET-023 T-SET-087 replacing the logo keeps the old file; it stays referenced by the profile version and cannot be deleted", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveCompanyProfile, { values: COMPANY });
    const first = await storePng(t, "alt");
    const second = await storePng(t, "neu");
    // convex-test keeps no content type, so the logo is set through the model (saveLayout validates it, SET-018).
    const as = { actor: owner.actor, role: "owner" as const, channel: "ui" as const };
    await t.model(as, (ctx) => patchCompanyProfile(ctx, { logoStorageId: first }, { action: "settings.logo.update" }));
    await t.model(as, (ctx) => patchCompanyProfile(ctx, { logoStorageId: second }, { action: "settings.logo.update" }));

    expect(await t.run(async (ctx) => (await ctx.storage.get(first)) !== null)).toBe(true);
    const refs = await t.run((ctx) => fileReferences(ctx, first));
    expect(refs.some((r) => r.startsWith("companyProfileVersions"))).toBe(true);
    const err = await t
      .model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) => deleteUnreferencedFile(ctx, first))
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe("immutable_record");
    expect(reasonOf(err)).toBe("FILE_REFERENCED");
    expect(await t.run(async (ctx) => (await ctx.storage.get(first)) !== null)).toBe(true);
  });

  test("SET-023 an upload that no setting references can be removed (audited)", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const orphan = await storePng(t, "verworfen");
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) => deleteUnreferencedFile(ctx, orphan));
    expect(await t.run(async (ctx) => (await ctx.storage.get(orphan)) !== null)).toBe(false);
    const entry = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    expect(entry).toMatchObject({ action: "settings.file.delete", entity: { table: "_storage", id: orphan } });
  });
});

describe("SET-054 archiving invoice accounts", () => {
  test("SET-054 the only invoice account cannot be archived; after another default it can", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveBankAccount, { values: BANK });
    const [main] = await owner.query(api.settings.listInvoiceAccounts, {});
    if (!main) throw new Error("no account");
    expect(
      await owner.mutation(api.settings.archiveBankAccount, { bankAccountId: main.bankAccountId }).catch(reasonOf),
    ).toBe("LAST_INVOICE_ACCOUNT");

    const second = (await owner.mutation(api.settings.addBankAccount, {
      values: {
        name: "Zweitkonto",
        iban: "DE02 1203 0000 0000 2020 51",
        bic: "",
        accountHolder: "Muster Design GmbH",
        currency: "EUR",
      },
    })) as Id<"bankAccounts">;
    expect(
      await owner.mutation(api.settings.archiveBankAccount, { bankAccountId: main.bankAccountId }).catch(reasonOf),
    ).toBe("DEFAULT_ACCOUNT");
    await owner.mutation(api.settings.setDefaultBankAccount, { bankAccountId: second });
    await owner.mutation(api.settings.archiveBankAccount, { bankAccountId: main.bankAccountId });

    const list = await owner.query(api.settings.listInvoiceAccounts, {});
    expect(list.find((a) => a.bankAccountId === main.bankAccountId)).toMatchObject({
      archivedAt: expect.any(Number),
      showOnInvoices: false,
      isDefaultForInvoices: false,
    });
    expect(list.find((a) => a.bankAccountId === second)).toMatchObject({
      isDefaultForInvoices: true,
      archivedAt: null,
    });
    const entry = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    expect(entry).toMatchObject({ action: "settings.bank_account.archive" });
  });
});

describe("SET-074 default layout per document type", () => {
  test("SET-074 a second layout becomes the default for quotes; invoices keep the standard layout", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveLayout, { values: LAYOUT });
    const angebot = (await owner.mutation(api.settings.createLayoutVariant, {
      values: { name: "Angebote modern" },
    })) as Id<"layouts">;
    await owner.mutation(api.settings.setLayoutDefaults, { layoutId: angebot, docTypes: ["quote"] });
    const layouts = await owner.query(api.settings.listLayoutsWithDefaults, {});
    const std = layouts.find((l) => l.name === "Standard");
    const variant = layouts.find((l) => l.layoutId === angebot);
    expect(variant).toMatchObject({ isDefaultFor: ["quote"], version: 1, template: "classic", accentColor: "#1F6FEB" });
    expect(std?.isDefaultFor).not.toContain("quote");
    expect(std?.isDefaultFor).toContain("invoice");
    expect(
      await owner
        .mutation(api.settings.setLayoutDefaults, { layoutId: angebot, docTypes: ["self_billing"] })
        .catch(errorCode),
    ).toBe("invalid_input");
  });
});

describe("SET-073 layout preview data", () => {
  test("SET-073 the preview gets the layout config, company footer data, invoice accounts and the KU status", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveCompanyProfile, { values: COMPANY });
    await owner.mutation(api.settings.saveBankAccount, { values: BANK });
    await owner.mutation(api.settings.saveLayout, { values: LAYOUT });
    const data = await owner.query(api.settings.layoutPreviewData, {});
    expect(data.layout?.config).toMatchObject({ template: "classic", accentColor: "#1F6FEB" });
    expect(data.company).toMatchObject({ name: "Muster Design GmbH", representatives: [{ name: "Max Mustermann" }] });
    expect(data.accounts).toEqual([
      {
        name: "Geschäftskonto",
        iban: "DE89370400440532013000",
        bic: "COBADEFFXXX",
        accountHolder: "Muster Design GmbH",
      },
    ]);
    expect(data.kleinunternehmer).toBe(false);
    // Viewers may look at the preview (settings.read), API keys need settings:read.
    const viewer = await t.asUser("viewer");
    expect((await viewer.query(api.settings.layoutPreviewData, {})).company?.name).toBe("Muster Design GmbH");
  });
});
