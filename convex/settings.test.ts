import { afterEach, describe, expect, test, vi } from "vitest";
import { canDo, type Permission, scopeFor } from "../src/domain/access/permissions";
import type { MemberRole } from "../src/domain/schemas/actor";
import { SCOPES } from "../src/domain/schemas/scopes";
import { type CompanyValues, companyDefaults, taxDefaults } from "../src/domain/schemas/settings";
import { api, components, internal } from "./_generated/api";
import { WRAPPER_TAG, type WrapperMeta } from "./functions";
import * as integrityModule from "./integrity";
import * as invitesModule from "./invites";
import { errorCode } from "./lib/errors";
import * as membersModule from "./members";
import * as settingsModule from "./settings";
import { makeT, type TestT } from "./test.setup";

const DAY = 86_400_000;
const AUTH_ERRORS = new Set(["unauthenticated", "forbidden_role", "forbidden_scope", "not_a_member"]);

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return errorCode(e) ?? String(e);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── form values ───────────────────────────────────────────────────────────────────────────────────────
const ACCESS = {
  countryCode: "DE",
  provider: "Eigener Server",
  nonEuConfirmed: false,
  tailnetName: "",
  tailnetOnlyConfirmed: true,
};
const COMPANY: CompanyValues = {
  ...companyDefaults,
  legalForm: "gmbh",
  name: "Muster GmbH",
  street: "Hauptstraße 1",
  postalCode: "10115",
  city: "Berlin",
  seat: "Berlin",
  contactName: "Erika Musterfrau",
  phone: "+49 30 123456",
  email: "info@muster.de",
  registerCourt: "Amtsgericht Berlin-Charlottenburg",
  registerNumber: "12345 B",
  representatives: [{ name: "Max Mustermann" }],
};
const TAX = {
  ...taxDefaults("gmbh"),
  taxNumberState: "BE",
  taxNumber: "27/815/08155",
  priorYearTurnover: "120.000,00",
};
const BANK = { iban: "DE89 3704 0044 0532 0130 00", bic: "COBADEFFXXX", accountHolder: "Muster GmbH", currency: "EUR" };
const LAYOUT = { template: "classic", accentColor: "#1F6FEB" };
const RANGES = {
  ranges: [{ key: "invoice", name: "Rechnungen", format: "RE-{YYYY}-{####}", resetPolicy: "yearly", next: 1 }],
};

// ── role matrix (02 §4.3, SET-142, CLAUDE.md rule 6) ───────────────────────────────────────────────────
type Fn = {
  [WRAPPER_TAG]?: WrapperMeta;
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  isPublic?: boolean;
};

/** Minimal arguments per public function (validation errors after the permission check count as "allowed"). */
const ARGS: Record<string, Record<string, unknown>> = {
  "settings:saveAccessConcept": { values: ACCESS },
  "settings:saveNotificationEmail": { values: { notificationEmail: "inhaber@muster.de" } },
  "settings:saveCompanyProfile": { values: COMPANY },
  "settings:saveTaxSettings": { values: TAX },
  "settings:saveBankAccount": { values: BANK },
  "settings:saveLayout": { values: LAYOUT },
  "settings:saveNumberRanges": { values: RANGES },
  "members:disable": { memberId: "placeholder", reason: "test" },
  "settings:createNumberRange": {
    values: { name: "Extra", docTypes: ["proforma"], format: "PX-{YYYY}-{###}", resetPolicy: "yearly", startValue: 1 },
  },
  "settings:deactivateNumberRange": { rangeId: "placeholder" },
  "settings:deleteNumberRange": { rangeId: "placeholder" },
  "members:changeRole": { memberId: "placeholder", role: "bookkeeper" },
  "members:extend": { memberId: "placeholder", expiresAt: Date.now() + 5 * DAY },
  "members:revokeSessions": { memberId: "placeholder" },
  "invites:create": { email: "neu@example.test", role: "viewer" },
  "invites:resend": { inviteId: "placeholder" },
  "invites:revoke": { inviteId: "placeholder" },
  "integrity:acknowledge": { runId: "placeholder", note: "geprüft" },
  "settings:addBankAccount": { values: { ...BANK, name: "Zweitkonto", iban: "DE02 1203 0000 0000 2020 51" } },
  "settings:setDefaultBankAccount": { bankAccountId: "placeholder" },
  "settings:archiveBankAccount": { bankAccountId: "placeholder" },
  "settings:createLayoutVariant": { values: { name: "Variante" } },
  "settings:setLayoutDefaults": { layoutId: "placeholder", docTypes: ["quote"] },
  "settings:layoutPreviewData": {},
};

const MODULES = {
  settings: settingsModule,
  members: membersModule,
  invites: invitesModule,
  integrity: integrityModule,
};

function publicFunctions() {
  const rows: { name: string; ref: unknown; kind: "query" | "mutation" | "action"; permission: Permission }[] = [];
  for (const [mod, exports] of Object.entries(MODULES)) {
    for (const [fn, value] of Object.entries(exports)) {
      const f = value as Fn;
      const meta = f?.[WRAPPER_TAG];
      if (!f?.isPublic || !meta?.permission) continue;
      const kind = f.isQuery ? "query" : f.isMutation ? "mutation" : "action";
      const ref = (api as unknown as Record<string, Record<string, unknown>>)[mod]?.[fn];
      rows.push({ name: `${mod}:${fn}`, ref, kind, permission: meta.permission as Permission });
    }
  }
  return rows;
}

type Caller = { query: TestT["query"]; mutation: TestT["mutation"]; action: TestT["action"] };

async function callers(t: TestT): Promise<Record<string, { caller: Caller; role?: MemberRole; scoped?: boolean }>> {
  const auditorOpts = { expiresAt: Date.now() + 10 * DAY, auditor: { purpose: "Az 1", fiscalYears: [2025] } };
  return {
    owner: { caller: await t.asUser("owner"), role: "owner" },
    bookkeeper: { caller: await t.asUser("bookkeeper"), role: "bookkeeper" },
    viewer: { caller: await t.asUser("viewer"), role: "viewer" },
    auditor: { caller: await t.asUser("auditor", auditorOpts), role: "auditor" },
    "api-key": { caller: await t.asApiKey([...SCOPES]), scoped: true },
    mcp: { caller: await t.asMcp([...SCOPES]), scoped: true },
    unauthenticated: { caller: t },
  };
}

const bankAccountOf = new WeakMap<TestT, string>();

async function resolvePlaceholders(t: TestT, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = { ...args };
  if (out.memberId === "placeholder") {
    out.memberId = (await t.seedUser("viewer")).memberId;
  }
  if (out.inviteId === "placeholder") {
    out.inviteId = await t.model({ actor: "user:seed", role: "owner", channel: "ui" }, async (ctx) =>
      (await import("./model/members")).createInvite(ctx, { email: `p-${Math.random()}@example.test`, role: "viewer" }),
    );
  }
  if (out.rangeId === "placeholder") {
    out.rangeId = await t.model({ actor: "user:seed", role: "owner", channel: "ui" }, async (ctx) =>
      (await import("./model/numberRanges")).createRange(
        ctx,
        {
          name: `R${Math.random()}`,
          docTypes: ["proforma"],
          format: "PR-{YYYY}-{###}",
          resetPolicy: "yearly",
          startValue: 1,
        },
        { year: 2026, month: 10 },
      ),
    );
  }
  if (out.bankAccountId === "placeholder") {
    // One account per test (IBANs are unique); later callers reuse it.
    const cached = bankAccountOf.get(t);
    out.bankAccountId =
      cached ??
      (await t.model({ actor: "user:seed", role: "owner", channel: "ui" }, async (ctx) =>
        (
          await import("./model/bankAccounts")
        ).addInvoiceAccount(
          ctx,
          { ...BANK, iban: "DE89370400440532013000", bic: "", currency: "EUR" as const, name: `K${Math.random()}` },
          "SKR03",
        ),
      ));
    bankAccountOf.set(t, out.bankAccountId as string);
  }
  if (out.layoutId === "placeholder") {
    out.layoutId = await t.model({ actor: "user:seed", role: "owner", channel: "ui" }, async (ctx) =>
      (await import("./model/layouts")).createLayout(ctx, `L${Math.random()}`),
    );
  }
  if (out.runId === "placeholder") {
    out.runId = await t.asSystem("cron.integrity.verify").model(async (ctx) =>
      (await import("./model/integrity")).recordIntegrityRun(ctx, {
        scope: "incremental",
        lastVerifiedSeq: 0,
        findings: [{ kind: "hash_mismatch", severity: "error", detail: "test" }],
      }),
    );
  }
  return out;
}

describe("role matrix of the settings, members, invites and integrity functions (02 §4.3)", () => {
  const rows = publicFunctions();

  test("SET-142 the matrix covers every new public function", () => {
    expect(rows.map((r) => r.name).sort()).toEqual(
      expect.arrayContaining([
        "settings:getSetupState",
        "settings:getSetupChecklist",
        "settings:setupStatus",
        "settings:saveAccessConcept",
        "settings:saveNotificationEmail",
        "settings:saveCompanyProfile",
        "settings:saveTaxSettings",
        "settings:saveBankAccount",
        "settings:generateLogoUploadUrl",
        "settings:saveLayout",
        "settings:saveNumberRanges",
        "settings:listNumberRanges",
        "settings:createNumberRange",
        "settings:deactivateNumberRange",
        "settings:deleteNumberRange",
        "settings:completeSetup",
        "settings:companyChangeImpact",
        "settings:listInvoiceAccounts",
        "settings:addBankAccount",
        "settings:setDefaultBankAccount",
        "settings:archiveBankAccount",
        "settings:listLayoutsWithDefaults",
        "settings:createLayoutVariant",
        "settings:setLayoutDefaults",
        "settings:layoutPreviewData",
        "settings:runAccessChecks",
        "settings:testCheckpointStorage",
        "members:list",
        "members:disable",
        "members:changeRole",
        "members:extend",
        "members:revokeSessions",
        "invites:list",
        "invites:create",
        "integrity:status",
        "integrity:acknowledge",
      ]),
    );
  });

  test.each(rows.map((r) => [r.name, r] as const))(
    "SEC-01 SET-142 %s: owner/bookkeeper/viewer/auditor/api-key/mcp/unauthenticated per the permission table",
    async (_name, row) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("", { status: 404 })),
      );
      const t = makeT();
      const all = await callers(t);
      for (const [label, { caller, role, scoped }] of Object.entries(all)) {
        const args = await resolvePlaceholders(t, ARGS[row.name] ?? {});
        const call = (caller[row.kind] as (ref: unknown, args: unknown) => Promise<unknown>).bind(caller);
        const code = await codeOf(call(row.ref, args));
        const allowed = role ? canDo(role, row.permission) : scoped ? scopeFor(row.permission) !== null : false;
        const expected = role ? "forbidden_role" : scoped ? "forbidden_scope" : "unauthenticated";
        if (allowed) expect(AUTH_ERRORS.has(code ?? ""), `${row.name} as ${label}: ${code}`).toBe(false);
        else expect(code, `${row.name} as ${label}`).toBe(expected);
      }
    },
  );
});

// ── behaviour ─────────────────────────────────────────────────────────────────────────────────────────
async function ownerWithPasskey(t: TestT) {
  const owner = await t.asUser("owner", { email: "owner@example.test" });
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "passkey",
      data: {
        userId: owner.userId,
        publicKey: "pk",
        credentialID: "cred-1",
        counter: 0,
        deviceType: "multiDevice",
        backedUp: true,
        createdAt: Date.now(),
      },
    },
  });
  return owner;
}

describe("setup wizard backend (F01 §3.1, SET-003/004/140/141)", () => {
  test("SET-003 SET-004 the wizard steps are saved, progress is derived and completing needs every required step", async () => {
    const t = makeT();
    const owner = await ownerWithPasskey(t);
    expect((await owner.query(api.settings.getSetupState, {})).completedSteps).toEqual(["inhaberkonto"]);
    expect(await codeOf(owner.mutation(api.settings.completeSetup, {}))).toBe("setup_incomplete");

    await owner.mutation(api.settings.saveAccessConcept, { values: ACCESS });
    await t.mutation(internal.signup.recordAuthMailDelivered, { transport: "memory" });
    const storage = await owner.action(api.settings.testCheckpointStorage, {});
    expect(storage.find((c) => c.id === "checkpoint")?.status).toBe("ok");
    const v1 = await owner.mutation(api.settings.saveCompanyProfile, { values: COMPANY });
    const v2 = await owner.mutation(api.settings.saveTaxSettings, { values: TAX, expectedVersion: v1 });
    await owner.mutation(api.settings.saveNumberRanges, { values: RANGES });
    expect(v2).toBe(v1 + 1);

    const checklist = await owner.query(api.settings.getSetupChecklist, {});
    expect(checklist.blocking).toEqual([]);
    expect(checklist.warnings.map((w) => w.code)).toContain("no_bank_account");
    const state = await owner.query(api.settings.getSetupState, {});
    expect(state.completedSteps).toEqual(
      expect.arrayContaining([
        "inhaberkonto",
        "zugriff",
        "email",
        "speicher",
        "start",
        "unternehmen",
        "steuern",
        "nummernkreise",
      ]),
    );
    expect(state.tax?.priorYearTurnover).toBe("120.000,00");
    expect(state.company?.name).toBe("Muster GmbH");

    expect((await owner.query(api.settings.setupStatus, {})).setupCompleted).toBe(false);
    await owner.mutation(api.settings.completeSetup, {});
    expect((await owner.query(api.settings.setupStatus, {})).setupCompleted).toBe(true);
  });

  test("SET-141 a stale version is refused with VERSION_CONFLICT and a German message", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const v1 = await owner.mutation(api.settings.saveCompanyProfile, { values: COMPANY });
    await owner.mutation(api.settings.saveCompanyProfile, {
      values: { ...COMPANY, city: "Potsdam" },
      expectedVersion: v1,
    });
    try {
      await owner.mutation(api.settings.saveCompanyProfile, { values: COMPANY, expectedVersion: v1 });
      expect.unreachable();
    } catch (e) {
      expect(errorCode(e)).toBe("version_conflict");
      expect((e as { data: { message: string } }).data.message).toBe(
        "Die Einstellungen wurden zwischenzeitlich geändert. Bitte neu laden.",
      );
    }
  });

  test("SET-140 SET-010 each settings save writes an audited diff and a new companyProfileVersions row (T-SET-010)", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveCompanyProfile, { values: COMPANY });
    await owner.mutation(api.settings.saveCompanyProfile, { values: { ...COMPANY, city: "Potsdam" } });
    const versions = await t.run((ctx) => ctx.db.query("companyProfileVersions").collect());
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "settings.company.update"))
        .collect(),
    );
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({ actor: owner.actor, channel: "ui" });
    expect(JSON.stringify(audit[1]?.diff)).toContain("Potsdam");
  });

  test("SET-143 the server re-validates with the shared zod schema (German message, nothing saved)", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    try {
      await owner.mutation(api.settings.saveCompanyProfile, { values: { ...COMPANY, postalCode: "1011" } });
      expect.unreachable();
    } catch (e) {
      expect(errorCode(e)).toBe("invalid_input");
      expect((e as { data: { message: string } }).data.message).toMatch(/Postleitzahl/);
    }
    expect(await t.run((ctx) => ctx.db.query("companyProfile").first())).toBeNull();
  });

  test("SET-142 tax status is owner-only even for API keys with settings:write", async () => {
    const t = makeT();
    const key = await t.asApiKey(["settings:write"]);
    expect(await codeOf(key.mutation(api.settings.saveTaxSettings, { values: TAX }))).toBe("forbidden_scope");
    expect(await codeOf(key.mutation(api.settings.saveAccessConcept, { values: ACCESS }))).toBe("forbidden_scope");
    await expect(key.mutation(api.settings.saveCompanyProfile, { values: COMPANY })).resolves.toBe(1);
  });

  test("SET-050 SET-051 SET-052 SET-053 the invoice bank account gets ledger 1200 (SKR03); a second save updates it", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveBankAccount, { values: BANK });
    await owner.mutation(api.settings.saveBankAccount, { values: { ...BANK, accountHolder: "Muster GmbH Berlin" } });
    const accounts = await t.run((ctx) => ctx.db.query("bankAccounts").collect());
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      iban: "DE89370400440532013000",
      ledgerAccount: "1200",
      isDefaultForInvoices: true,
    });
  });

  test("SET-070 SET-071 saving the layout creates a new layout version only when something changed", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveLayout, { values: LAYOUT });
    await owner.mutation(api.settings.saveLayout, { values: LAYOUT });
    await owner.mutation(api.settings.saveLayout, { values: { ...LAYOUT, template: "modern" } });
    const versions = await t.run((ctx) => ctx.db.query("layoutVersions").collect());
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });

  test("SET-018 a logo that is not PNG/JPG/SVG ≤ 2 MB is refused", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"], { type: "application/pdf" })));
    try {
      await owner.mutation(api.settings.saveLayout, { values: LAYOUT, logoStorageId: storageId });
      expect.unreachable();
    } catch (e) {
      expect((e as { data: { reason: string } }).data.reason).toBe("LOGO_INVALID");
    }
  });

  test("SET-006 the number ranges are seeded once; saved formats come back with the next value", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveNumberRanges, { values: RANGES });
    await owner.mutation(api.settings.saveNumberRanges, { values: RANGES });
    const ranges = await t.run((ctx) => ctx.db.query("numberRanges").collect());
    expect(ranges.filter((r) => r.name === "Rechnungen")).toHaveLength(1);
    const state = await owner.query(api.settings.getSetupState, {});
    expect(state.numberRanges?.find((r) => r.key === "invoice")).toMatchObject({ format: "RE-{YYYY}-{####}", next: 1 });
  });

  test("SET-046 AO-06 SET-007 a non-EU server location is saved with the Finanzamt approval as audit reason", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    expect(
      await codeOf(owner.mutation(api.settings.saveAccessConcept, { values: { ...ACCESS, countryCode: "US" } })),
    ).toBe("invalid_input");
    await owner.mutation(api.settings.saveAccessConcept, {
      values: { ...ACCESS, countryCode: "US", nonEuConfirmed: true },
    });
    const entry = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "settings.access.update"))
        .first(),
    );
    expect(entry?.reason).toMatch(/§ 146 Abs\. 2b AO/);
  });
});

describe("checkpoint storage test (SET-009b, SET-115)", () => {
  test("SET-009b SET-115 write + read + delete probe, bucket-lock warning, result stored for the wizard", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const checks = await owner.action(api.settings.testCheckpointStorage, {});
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["checkpoint", "ok"],
      ["bucketLock", "warning"],
      ["backups", "warning"],
    ]);
    const state = await owner.query(api.settings.getSetupState, {});
    expect(state.storage.checks[0]).toMatchObject({ id: "checkpoint", status: "ok" });
    expect(state.completedSteps).toContain("speicher");
    const integration = await t.run((ctx) =>
      ctx.db
        .query("integrations")
        .filter((q) => q.eq(q.field("kind"), "r2_checkpoint"))
        .first(),
    );
    expect(integration?.lastTestOk).toBe(true);
  });
});

describe("members list (04 §4.10)", () => {
  test("SEC-01 the owner sees passkey state and the last sign-in of every member", async () => {
    const t = makeT();
    const owner = await ownerWithPasskey(t);
    await t.seedUser("bookkeeper", { email: "buch@example.test" });
    const list = await owner.query(api.members.list, {});
    expect(list.find((m) => m.email === "owner@example.test")).toMatchObject({
      role: "owner",
      hasPasskey: true,
      lastSignInAt: expect.any(Number),
    });
    expect(list.find((m) => m.email === "buch@example.test")).toMatchObject({ hasPasskey: false });
  });
});
