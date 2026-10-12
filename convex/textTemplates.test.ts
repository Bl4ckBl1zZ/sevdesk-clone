import { describe, expect, test } from "vitest";
import { SALES_DOC_TYPES } from "../src/domain/documents/layout";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import { seedSettingsDefaults } from "./model/seeds";
import { makeT } from "./test.setup";

const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;
const HEAD = {
  kind: "document_head",
  docTypes: ["invoice"],
  language: "de",
  name: "Kopftext Projekt",
  body: "<p>{{contact.letterSalutation}}</p><p>für das Projekt {{document.subject}}:</p>",
  isDefault: true,
};

describe("SET-086 seeded templates", () => {
  test("SET-086 completing the setup seeds DE/EN head, foot and message text for every document type; restoring is idempotent", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) => seedSettingsDefaults(ctx));
    const list = await owner.query(api.lookups.listTextTemplates, {});
    expect(list).toHaveLength(SALES_DOC_TYPES.length * 3 * 2);
    expect(list.every((x) => x.isDefault)).toBe(true);
    expect(await owner.mutation(api.lookups.restoreDefaultTextTemplates, {})).toBe(0);
  });
});

describe("SET-080 SET-081 SET-082 saving templates", () => {
  test("SET-080 a new default for (head, invoice, de) replaces the seeded default; others stay", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) => seedSettingsDefaults(ctx));
    const id = (await owner.mutation(api.lookups.saveTextTemplate, { values: HEAD })) as Id<"textTemplates">;
    const list = await owner.query(api.lookups.listTextTemplates, {});
    const defaults = list.filter(
      (x) => x.isDefault && x.kind === "document_head" && x.language === "de" && x.docTypes.includes("invoice"),
    );
    expect(defaults.map((x) => x.templateId)).toEqual([id]);
    expect(list.find((x) => x.name === "Standard Kopftext Rechnung (EN)")?.isDefault).toBe(true);
    expect(list.find((x) => x.name === "Standard Fußtext Rechnung (DE)")?.isDefault).toBe(true);
  });

  test("SET-081 T-SET-046 script and event handlers are stripped on save (audited)", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const id = (await owner.mutation(api.lookups.saveTextTemplate, {
      values: { ...HEAD, body: '<p onclick="steal()">Hallo</p><script>alert(1)</script>' },
    })) as Id<"textTemplates">;
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.body).toBe("<p>Hallo</p>");
    const entry = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    expect(entry).toMatchObject({ action: "settings.text_template.create" });
  });

  test("SET-082 T-SET-043 unknown placeholders and custom fields that do not exist are rejected on the server", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const unknown = await owner
      .mutation(api.lookups.saveTextTemplate, { values: { ...HEAD, body: "{{contact.foo}}" } })
      .catch((e: unknown) => e);
    expect(errorCode(unknown)).toBe("invalid_input");
    const custom = await owner
      .mutation(api.lookups.saveTextTemplate, { values: { ...HEAD, body: "{{contact.custom.projekt}}" } })
      .catch(reasonOf);
    expect(custom).toBe("PLACEHOLDER_UNKNOWN");
    const notAllowed = await owner
      .mutation(api.lookups.saveTextTemplate, { values: { ...HEAD, body: "{{reminder.level}}" } })
      .catch((e: unknown) => (e as { data?: { message?: string } }).data?.message);
    expect(notAllowed).toBe("Der Platzhalter {{reminder.level}} ist in Vorlagen für Rechnung nicht verfügbar.");
  });

  test("SET-080 editing and deleting a template", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const id = (await owner.mutation(api.lookups.saveTextTemplate, { values: HEAD })) as Id<"textTemplates">;
    await owner.mutation(api.lookups.saveTextTemplate, {
      templateId: id,
      values: { ...HEAD, kind: "message_text", subject: "{{document.typeLabel}} {{document.number}}", body: "x" },
    });
    expect((await owner.query(api.lookups.listTextTemplates, {}))[0]).toMatchObject({
      kind: "message_text",
      subject: "{{document.typeLabel}} {{document.number}}",
    });
    await owner.mutation(api.lookups.deleteTextTemplate, { templateId: id });
    expect(await owner.query(api.lookups.listTextTemplates, {})).toEqual([]);
  });
});
