import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { taxDefaults } from "../src/domain/schemas/settings";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BERLIN, createValues, orgForm } from "./catalog.fixtures";
import { invoiceValues, setupInvoicing } from "./invoices.fixtures";
import { memoryBucketLock, memoryFailures } from "./lib/checkpointStore";
import { errorCode } from "./lib/errors";
import { patchCompanyProfile } from "./model/companyProfile";
import { recordIntegrationTest } from "./model/integrations";
import { makeT, type TestT } from "./test.setup";

/**
 * F01 settings — the live checks (SET-007 access checks, SET-009b/SET-115 storage probe), the layout preview data
 * (SET-073), the wizard state with a real mail transport (SET-003), the tax-settings error mapping (SET-041) and
 * the smaller guards of convex/settings.ts.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  memoryFailures.remaining = 0;
  memoryBucketLock.value = "unknown";
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

type Reply = number | Error | { status: number; body: string };

/** fetch stub: the first matching rule (substring of "METHOD url") answers. */
function stubFetch(rules: [string, Reply][]) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const line = `${req.method} ${req.url}`;
    calls.push(line);
    const hit = rules.find(([needle]) => line.includes(needle));
    const reply = hit ? hit[1] : 200;
    if (reply instanceof Error) throw reply;
    const { status, body } = typeof reply === "number" ? { status: reply, body: "" } : reply;
    return new Response(status === 204 ? null : body, { status });
  });
  return calls;
}

const ownerCtx = (owner: Awaited<ReturnType<TestT["asUser"]>>) =>
  ({ actor: owner.actor, role: "owner", channel: "ui" }) as const;

describe("SET-007 live access checks", () => {
  test("SET-007 E-AUD-22 unreachable hosts, admin pages on api., a dashboard without basic auth are errors", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    stubFetch([
      ["https://app.test.local/api/health", 200],
      ["https://api.test.local:8443/", new Error("connection refused")],
      ["https://api.test.local/einstellungen", 200],
      ["https://convex.test.local/version", new Error("certificate has expired")],
      ["https://convex-dash.test.local/", 200],
    ]);
    const checks = await owner.action(api.settings.runAccessChecks, {});
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.app).toMatchObject({ status: "ok", detail: "HTTPS 200" });
    expect(byId.convex).toMatchObject({
      status: "error",
      detail: "Nicht erreichbar oder Zertifikat ungültig: certificate has expired",
    });
    expect(byId["api-ui"]).toMatchObject({ status: "error" });
    expect(byId["api-ui"]?.detail).toContain("api.test.local");
    expect(byId["dash-auth"]).toMatchObject({ status: "error", detail: "Erwartet 401, erhalten 200." });
    expect(byId.rp).toMatchObject({ status: "ok", detail: "test.local" });
    expect(byId.session?.status).toBe("ok");
  });

  test("SET-007 E-AUD-22 admin pages on port 8443 are reported; a protected dashboard passes; a different RP ID fails", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    vi.stubEnv("PASSKEY_RP_ID", "andere.test");
    stubFetch([
      ["https://api.test.local:8443/einstellungen", 200],
      ["https://api.test.local/einstellungen", 404],
      ["https://convex-dash.test.local/", 401],
    ]);
    const checks = await owner.action(api.settings.runAccessChecks, {});
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId["api-ui"]?.detail).toContain("api.test.local:8443");
    expect(byId["dash-auth"]).toBeUndefined();
    expect(byId.rp).toMatchObject({ status: "error", detail: "andere.test ≠ test.local" });
  });

  test("SET-007 an unreachable api. host skips the exposure check; without BASE_DOMAIN only the domain error is shown", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    stubFetch([["https://api.test.local/", new Error("timeout")]]);
    const checks = await owner.action(api.settings.runAccessChecks, {});
    expect(checks.find((c) => c.id === "api")?.status).toBe("error");
    expect(checks.find((c) => c.id === "api-ui")).toBeUndefined();

    vi.stubEnv("BASE_DOMAIN", "");
    vi.stubEnv("PASSKEY_RP_ID", "");
    expect(await owner.action(api.settings.runAccessChecks, {})).toEqual([
      { id: "domain", label: "BASE_DOMAIN", status: "error", detail: "BASE_DOMAIN ist nicht gesetzt." },
    ]);
    const state = await owner.query(api.settings.getSetupState, {});
    expect(state.access).toMatchObject({ baseDomain: "", hosts: [] });
  });
});

describe("SET-009b SET-115 checkpoint storage probe", () => {
  test("SET-009b a failed write is reported; a bucket lock is ok", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    memoryFailures.remaining = 1;
    memoryBucketLock.value = "present";
    const checks = await owner.action(api.settings.testCheckpointStorage, {});
    expect(checks.slice(0, 2)).toEqual([
      {
        id: "checkpoint",
        label: "Prüfpunkt-Bucket (R2)",
        status: "error",
        detail: "Schreiben fehlgeschlagen: simulated upload failure",
      },
      {
        id: "bucketLock",
        label: "Aufbewahrungssperre (Bucket Lock)",
        status: "ok",
        detail: "Aufbewahrungsregel vorhanden.",
      },
    ]);
    // the failed test is shown in the wizard with its detail
    const state = await owner.query(api.settings.getSetupState, {});
    expect(state.storage.checks).toEqual([
      {
        id: "checkpoint",
        label: "Prüfpunkt-Bucket (R2)",
        status: "error",
        detail: "Schreiben fehlgeschlagen: simulated upload failure",
      },
    ]);
  });

  test("SET-009b SET-115 real R2: differing read, failed delete and the backup bucket answers", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    for (const [k, v] of Object.entries({
      R2_ACCOUNT_ENDPOINT: "https://r2.example.test",
      R2_CHECKPOINT_BUCKET: "checkpoints",
      R2_CHECKPOINT_ACCESS_KEY_ID: "id",
      R2_CHECKPOINT_SECRET_ACCESS_KEY: "secret",
      R2_BACKUP_BUCKET: "backups",
      R2_BACKUP_READONLY_ACCESS_KEY_ID: "rid",
      R2_BACKUP_READONLY_SECRET_ACCESS_KEY: "rsecret",
    }))
      vi.stubEnv(k, v);
    const listing =
      "<ListBucketResult><Contents><Key>postgres/a.dump</Key><LastModified>2026-10-11T03:00:00Z</LastModified></Contents></ListBucketResult>";
    stubFetch([
      ["GET https://r2.example.test/checkpoints/probe/", { status: 200, body: "etwas anderes" }],
      ["?object-lock", { status: 200, body: "<ObjectLockConfiguration/>" }],
      ["list-type=2", { status: 200, body: listing }],
    ]);
    let checks = await owner.action(api.settings.testCheckpointStorage, {});
    expect(checks.map((c) => [c.id, c.status, c.detail])).toEqual([
      ["checkpoint", "error", "Lesen fehlgeschlagen: Inhalt weicht ab."],
      [
        "bucketLock",
        "warning",
        "Für den Prüfpunkt-Bucket ist keine Aufbewahrungssperre (Bucket Lock) eingerichtet. Empfohlen, damit Prüfpunkte nicht gelöscht werden können (SEC-04).",
      ],
      ["backups", "ok", "Letzte Sicherung: 2026-10-11T03:00:00Z"],
    ]);

    // the read matches, the delete fails, the backup bucket is empty
    const body = `probe ${Date.now()}`;
    stubFetch([
      ["GET https://r2.example.test/checkpoints/probe/", { status: 200, body }],
      ["DELETE", { status: 409, body: "kaputt" }],
      ["?object-lock", 403],
      ["list-type=2", { status: 200, body: "<ListBucketResult/>" }],
    ]);
    checks = await owner.action(api.settings.testCheckpointStorage, {});
    expect(checks.map((c) => [c.id, c.detail])).toEqual([
      ["checkpoint", "Löschen fehlgeschlagen: HTTP 409: kaputt"],
      ["bucketLock", expect.stringContaining("keine Aufbewahrungssperre")],
      ["backups", "Noch keine Sicherung im Backup-Bucket."],
    ]);

    // a successful probe against R2; the backup bucket cannot be read
    stubFetch([
      ["GET https://r2.example.test/checkpoints/probe/", { status: 200, body }],
      ["list-type=2", 403],
    ]);
    checks = await owner.action(api.settings.testCheckpointStorage, {});
    expect(checks[0]).toMatchObject({
      status: "ok",
      detail: "Schreiben, Lesen und Löschen erfolgreich (r2://checkpoints).",
    });
    expect(checks[2]).toMatchObject({ status: "warning", detail: "Backup-Bucket nicht lesbar: HTTP 403" });
  });
});

describe("SET-003 SET-073 wizard state and layout preview", () => {
  test("SET-003 with Cloudflare mail the sender and token state come from the environment; the last delivery is shown", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    vi.stubEnv("AUTH_MAIL_SENDER", "cloudflare");
    vi.stubEnv("AUTH_MAIL_FROM", "anmeldung@test.local");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc-1");
    let state = await owner.query(api.settings.getSetupState, {});
    expect(state.email).toMatchObject({ sender: "anmeldung@test.local", accountId: "acc-1", tokenConfigured: false });
    expect(state.email.lastDelivery).toBeUndefined();
    vi.stubEnv("CLOUDFLARE_EMAIL_API_TOKEN", "tok");
    await t.model(ownerCtx(owner), (ctx) =>
      recordIntegrationTest(ctx, "cloudflare_email", { ok: false, detail: "HTTP 403" }),
    );
    state = await owner.query(api.settings.getSetupState, {});
    expect(state.email.tokenConfigured).toBe(true);
    expect(state.email.lastDelivery).toEqual({
      id: "delivery",
      label: "Letzte Zustellung",
      status: "error",
      detail: "HTTP 403",
    });
    // no access concept yet → no stored values; no profile → no company/tax
    expect(state.access).not.toHaveProperty("values");
    expect(state).not.toHaveProperty("company");
  });

  test("SET-003 SET-007 SET-050 stored access concept with tailnet, bank account without BIC, layout and completed setup", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.mutation(api.settings.saveAccessConcept, {
      values: {
        countryCode: "DE",
        provider: "Hetzner",
        nonEuConfirmed: false,
        tailnetName: "firma.ts.net",
        tailnetOnlyConfirmed: true,
      },
    });
    await owner.mutation(api.settings.saveLayout, { values: { template: "modern", accentColor: "#16A34A" } });
    const state = await owner.query(api.settings.getSetupState, {});
    expect(state.access.values).toEqual({
      countryCode: "DE",
      provider: "Hetzner",
      nonEuConfirmed: false,
      tailnetName: "firma.ts.net",
      tailnetOnlyConfirmed: true,
    });
    expect(state.layout).toEqual({ template: "modern", accentColor: "#16A34A" });
    expect(state.setupCompletedAt).toBe(Date.now());
    expect(state.bank?.iban).toBeTruthy();
    expect(state.company?.name).toBeTruthy();
  });

  test("SET-073 SET-072 the preview carries every optional company field, the invoice accounts and the letterhead URLs", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await t.model(ownerCtx(owner), (ctx) =>
      patchCompanyProfile(
        ctx,
        {
          tradeName: "Muster Design",
          generalPartner: {
            name: "Muster Verwaltungs GmbH",
            seat: "Berlin",
            registerCourt: "Amtsgericht Charlottenburg",
            registerNumber: "HRB 1",
            managingDirectors: ["Max Muster"],
          },
          supervisoryBoardChair: "Erika Aufsicht",
        } as never,
        { action: "settings.company.update" },
      ),
    );
    await owner.mutation(api.settings.saveLayout, { values: { template: "classic", accentColor: "#1F6FEB" } });
    const [layout] = await owner.query(api.settings.listLayoutsWithDefaults, {});
    const layoutId = layout?.layoutId as Id<"layouts">;
    const pdf = await t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.7"])));
    for (const slot of ["first", "follow"] as const)
      await t.mutation(internal.settings.setLetterhead, {
        actorContext: ownerCtx(owner),
        layoutId,
        slot,
        storageId: pdf,
      });
    // a second account without BIC
    await owner.mutation(api.settings.addBankAccount, {
      values: {
        name: "Rücklagen",
        iban: "DE02 1203 0000 0000 2020 51",
        bic: "",
        accountHolder: "Muster GmbH",
        currency: "EUR",
      },
    });
    const data = await owner.query(api.settings.layoutPreviewData, { layoutId });
    expect(data.company).toMatchObject({
      tradeName: "Muster Design",
      seat: expect.any(String),
      register: expect.any(Object),
      generalPartner: expect.objectContaining({ name: "Muster Verwaltungs GmbH" }),
      supervisoryBoardChair: "Erika Aufsicht",
      shareCapital: expect.any(Object),
      taxNumber: expect.any(String),
      taxNumberState: expect.any(String),
      vatId: expect.any(String),
    });
    expect(data.accounts.map((a) => [a.name, a.bic])).toEqual([
      [expect.any(String), expect.any(String)],
      ["Rücklagen", undefined],
    ]);
    expect(data.letterheadUrl).toMatch(/^https:/);
    expect(data.letterheadFollowUrl).toMatch(/^https:/);
    expect(data.kleinunternehmer).toBe(false);
    const listed = await owner.query(api.settings.listLayoutsWithDefaults, {});
    expect(listed[0]).toMatchObject({ letterhead: true, letterheadFollow: true });
    const accounts = await owner.query(api.settings.listInvoiceAccounts, {});
    expect(accounts.map((a) => [a.name, a.isDefaultForInvoices, a.bic])).toEqual([
      [expect.any(String), true, expect.any(String)],
      ["Rücklagen", false, ""],
    ]);
  });

  test("SET-073 without a company profile or layout the preview is empty", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    expect(await owner.query(api.settings.layoutPreviewData, {})).toMatchObject({
      layout: null,
      company: null,
      accounts: [],
      kleinunternehmer: false,
      logoUrl: null,
      letterheadUrl: null,
      letterheadFollowUrl: null,
    });
  });
});

describe("SET-030…SET-044 tax settings guards", () => {
  async function journaled(t: TestT) {
    const { owner } = await setupInvoicing(t);
    const { id: contactId } = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Alpha GmbH"), { address: BERLIN }),
    });
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(contactId) });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    return owner;
  }
  const TAX = {
    ...taxDefaults("gmbh"),
    taxNumberState: "BE",
    taxNumber: "27/815/08155",
    priorYearTurnover: "120.000,00",
    ustvaPeriod: "monthly",
  };

  test("SET-041 SET-042 a chart switch or a new fiscal year start after the first booking is refused (chart_locked)", async () => {
    const t = makeT();
    const owner = await journaled(t);
    const chart = await catching(
      owner.mutation(api.settings.saveTaxSettings, { values: { ...TAX, chartOfAccounts: "SKR04" } }),
    );
    expect(errorCode(chart)).toBe("chart_locked");
    expect(dataOf(chart)).toMatchObject({
      reason: "CHART_LOCKED",
      message: "Der Kontenrahmen kann erst zum Beginn des nächsten Wirtschaftsjahres gewechselt werden.",
    });
    const method = await catching(
      owner.mutation(api.settings.saveTaxSettings, { values: { ...TAX, taxationMethod: "ist", istConfirmed: true } }),
    );
    expect(errorCode(method)).toBe("invalid_input");
    expect(dataOf(method).reason).toBe("TAXATION_METHOD_LOCKED");
  });

  test("SET-031 SET-034 the Ist approval and a KU reason become the audit reason", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveTaxSettings, {
      values: { ...TAX, taxationMethod: "ist", istConfirmed: true },
    });
    await owner.mutation(api.settings.saveTaxSettings, {
      values: { ...TAX, kuReason: "Rückwirkende Korrektur laut Bescheid" },
    });
    const reasons = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((a) => a.action === "settings.tax.update").map((a) => a.reason),
    );
    expect(reasons).toEqual([
      "Genehmigung des Finanzamts für die Ist-Versteuerung liegt vor",
      "Rückwirkende Korrektur laut Bescheid",
    ]);
  });
});

describe("SET-018 SET-035 SET-134 smaller guards", () => {
  test("SET-018 a logo file that no longer exists is refused; SET-035 an unknown document is not found", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const gone = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(["png"]));
      await ctx.storage.delete(id);
      return id;
    });
    const e = await catching(
      owner.mutation(api.settings.saveLayout, {
        values: { template: "classic", accentColor: "#1F6FEB" },
        logoStorageId: gone,
      }),
    );
    expect(dataOf(e).reason).toBe("LOGO_INVALID");
    expect(errorCode(await catching(owner.mutation(api.settings.confirmKuLimitCrossed, { documentId: "kein" })))).toBe(
      "not_found",
    );
  });

  test("SET-134 every registered cron appears in the status table with its job", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const rows = await owner.query(api.settings.cronStatus, {});
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every((r) => typeof r.name === "string")).toBe(true);
  });
});
