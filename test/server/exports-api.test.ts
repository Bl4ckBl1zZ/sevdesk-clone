import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { finalizedInvoice, settle } from "../../convex/invoices.fixtures";
import { patchCompanyProfile } from "../../convex/model/companyProfile";
import type { TestT } from "../../convex/test.setup";
import { apiTest, call } from "./harness";

/**
 * 05 §4.7 reports and F09 §7 exports over REST (API-023, API-024): EÜR, BWA, SuSa, Kontenblatt, OPOS and the
 * Kennzahlen sheets read the same Convex functions as the UI; DATEV/GDPdU/full exports start attributed jobs that
 * clients poll with GET /jobs/{id}.
 */

let restore: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
});
afterEach(() => {
  restore?.();
  restore = undefined;
  vi.useRealTimers();
});

function setup() {
  const h = apiTest();
  restore = h.restore;
  return h.t;
}

type Json = Record<string, unknown>;
const json = async (res: Response) => (await res.json()) as Json;

async function withDatev(t: TestT, actor: `user:${string}`) {
  await t.model({ actor, role: "owner", channel: "ui" } as const, (ctx) =>
    patchCompanyProfile(
      ctx,
      { datev: { consultantNumber: 1234567, clientNumber: 12345, accountLength: 4, personalAccounts: true } },
      { action: "settings.company.update" },
    ),
  );
}

const DATEV = { from: "2026-10-01", to: "2026-10-31" };

describe("REST reports (05 §4.7, API-023)", { timeout: 180_000 }, () => {
  test("API-023 RPT-004 RPT-005 RPT-006 SuSa, BWA, Kontenblatt and OPOS carry the F08 values on the wire (snake_case, cents, prefixed ids)", async () => {
    const t = setup();
    const f = await finalizedInvoice(t);
    const key = (await t.asApiKey(["reports:read"])).key;

    const susa = await call("GET", "/reports/susa?from=2026-10-01&to=2026-10-31", { key });
    expect(susa.status).toBe(200);
    const s = await json(susa);
    const direct = await f.owner.query(api.reports.susa, { from: "2026-10-01", to: "2026-10-31" });
    expect(s).toMatchObject({ currency: "EUR", from: "2026-10-01", to: "2026-10-31", balanced: direct.balanced });
    expect((s.totals as Json).period_debit_cents).toBe(direct.totals.periodDebitCents);
    expect((s.rows as Json[]).length).toBe(direct.rows.length);
    expect((s.meta as Json).generated_at).toBe("2026-10-12T10:00:00.000Z");

    const bwa = await json(await call("GET", "/reports/bwa?month=2026-10", { key }));
    const bwaDirect = await f.owner.query(api.reports.bwa, { month: "2026-10", variant: "accrual" });
    expect(bwa).toMatchObject({ month: "2026-10", variant: "accrual" });
    expect((bwa.rows as Json[]).find((r) => r.key === "umsatz")?.month_cents).toBe(
      bwaDirect.rows.find((r) => r.key === "umsatz")?.monthCents,
    );

    const revenueAccount = direct.rows.find((r) => r.periodCreditCents > 0 && r.accountClass === "8");
    if (!revenueAccount) throw new Error("no revenue account in the SuSa");
    const ledger = await json(
      await call("GET", `/reports/ledger?account=${revenueAccount.account}&from=2026-10-01&to=2026-10-31`, { key }),
    );
    expect(ledger).toMatchObject({ account: revenueAccount.account, credit_cents: revenueAccount.periodCreditCents });

    const opos = await json(await call("GET", "/reports/open-items?as_of=2026-10-12", { key }));
    expect(opos).toMatchObject({ side: "debtors", as_of: "2026-10-12" });
    const item = (opos.items as Json[]).find((i) => i.number === f.number);
    expect(item).toMatchObject({ id: `inv_${f.id}`, open_cents: expect.any(Number), currency: "EUR" });
    expect(item?.open_cents).toBeGreaterThan(0);
    expect(String(item?.contact_id)).toMatch(/^con_/);
    expect(opos.reconciliation).toMatchObject({ difference_cents: 0, message: null });

    // query validation and the scope check
    expect((await call("GET", "/reports/bwa?month=2026-13", { key })).status).toBe(400);
    const noScope = (await t.asApiKey(["documents:read"])).key;
    const denied = await call("GET", "/reports/susa?from=2026-10-01&to=2026-10-31", { key: noScope });
    expect(denied.status).toBe(403);
    expect(await json(denied)).toMatchObject({ code: "insufficient_scope", required_scope: "reports:read" });
  });

  test("API-023 TAX-015 EXP-020 GET /reports/euer and the EÜR Kennzahlen sheet (CSV) equal the Convex values; the download is audited for the key", async () => {
    const t = setup();
    const f = await finalizedInvoice(t);
    await settle(t);
    const { key, actor } = await t.asApiKey(["reports:read"]);
    const res = await call("GET", "/reports/euer?year=2026", { key });
    expect(res.status).toBe(200);
    const euer = await json(res);
    const direct = await f.owner.query(api.taxes.euer, { year: 2026 });
    expect(euer).toMatchObject({ year: 2026, currency: "EUR", form_name: direct.sheet.formName });
    expect(euer.values).toEqual(direct.values);
    expect((euer.sums as Json).gewinn_cents).toBe(direct.sheet.sums.gewinnCents);

    const sheet = await call("GET", "/reports/euer/2026/sheet.csv", { key });
    expect(sheet.status).toBe(200);
    const file = await json(sheet);
    expect(file).toMatchObject({ file_name: "EUER_2026_Kennzahlen.csv", content_type: "text/csv;charset=utf-8" });
    const text = Buffer.from(String(file.content_base64), "base64").toString("utf8");
    expect(text.length).toBeGreaterThan(0);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    const entry = audit.find((e) => e.action === "export.kennzahlen");
    expect(entry?.actor).toBe(actor);
    expect((entry?.diff as { after?: { sha256?: string } } | undefined)?.after?.sha256).toBe(file.sha256);

    // a UStVA period for the EÜR form is refused before Convex is asked
    const bad = await call("GET", "/reports/euer/2026-10/sheet.csv", { key });
    expect(bad.status).toBe(422);
    expect(await json(bad)).toMatchObject({ errors: [{ code: "invalid_period", field: "period" }] });
  });
});

describe("REST exports and jobs (F09 §7, API-024)", { timeout: 180_000 }, () => {
  test("API-024 EXP-007 E-EXP-01 POST /exports/datev answers 422 with the blocking report and starts nothing; validate is a dry run", async () => {
    const t = setup();
    await finalizedInvoice(t);
    const key = (await t.asApiKey(["exports:run"])).key;
    const v = await call("POST", "/exports/datev/validate", { key, body: DATEV });
    expect(v.status).toBe(200);
    const report = await json(v);
    expect(report.blocking).toBe(true);
    expect((report.issues as Json[]).map((i) => i.message)).toContain(
      "Für den DATEV-Export fehlen Berater- und/oder Mandantennummer (Einstellungen › Unternehmen › DATEV).",
    );
    const res = await call("POST", "/exports/datev", { key, body: DATEV });
    expect(res.status).toBe(422);
    const problem = await json(res);
    expect(problem).toMatchObject({ code: "validation_failed", report: { blocking: true } });
    expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(0);
  });

  test("API-024 EXP-009 EXP-016 E-EXP-18 E-EXP-20 DATEV job → GET /jobs/{id} → history → stored ZIP only with the „Testexport“ confirmation", async () => {
    const t = setup();
    const f = await finalizedInvoice(t);
    await withDatev(t, f.owner.actor);
    const { key, actor } = await t.asApiKey(["exports:run"]);
    const started = await call("POST", "/exports/datev", { key, body: DATEV });
    expect(started.status).toBe(202);
    const { job_id } = (await json(started)) as { job_id: string };
    expect(job_id).toMatch(/^job_/);

    // E-EXP-20: an overlapping export while the first one is queued
    const overlap = await call("POST", "/exports/datev", { key, body: { ...DATEV, from: "2026-10-15" } });
    expect(overlap.status).toBe(409);
    expect((await json(overlap)).detail).toBe("Für diesen Zeitraum läuft bereits ein Export.");

    await settle(t);
    const job = await json(await call("GET", `/jobs/${job_id}`, { key }));
    expect(job).toMatchObject({ id: job_id, kind: "datev_export", status: "done", actor, error: null });

    const list = await json(await call("GET", "/exports/datev", { key }));
    const [row] = list.data as Json[];
    expect(row).toMatchObject({ from: "2026-10-01", to: "2026-10-31", mode: "new", actor });
    expect(String(row?.id)).toMatch(/^dvx_/);

    const refused = await call("GET", `/exports/datev/${row?.id}/file`, { key });
    expect(refused.status).toBe(422);
    expect(await json(refused)).toMatchObject({ errors: [{ code: "datev_test_confirmation_required" }] });
    const file = await json(await call("GET", `/exports/datev/${row?.id}/file?test_confirmed=true`, { key }));
    expect(file).toMatchObject({ file_name: row?.file_name, sha256: row?.sha256 });
    expect(file.url).toBeTruthy();
    const actions = (await t.run((ctx) => ctx.db.query("auditLog").collect()))
      .filter((e) => e.actor === actor)
      .map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["export.datev", "export.datev_test_download"]));
  });

  test("API-024 EXP-011 lock_period locks the months before the export (Festschreibung 1)", async () => {
    const t = setup();
    const f = await finalizedInvoice(t);
    await withDatev(t, f.owner.actor);
    const key = (await t.asApiKey(["exports:run"])).key;
    const res = await call("POST", "/exports/datev", { key, body: { ...DATEV, lock_period: true } });
    expect(res.status).toBe(202);
    await settle(t);
    const periods = await t.run((ctx) => ctx.db.query("periods").collect());
    expect(periods.find((p) => p.period === "2026-10")).toMatchObject({ status: "locked", reason: "datev_export" });
    const [row] = await t.run((ctx) => ctx.db.query("datevExports").collect());
    expect(row?.festschreibung).toBe(true);
  });

  test("API-024 EXP-017 EXP-023 EXP-026 GDPdU and full export start jobs for the key; age encryption → 501; another key's job is not found", async () => {
    const t = setup();
    await finalizedInvoice(t);
    const { key, actor } = await t.asApiKey(["exports:run"]);
    const g = await call("POST", "/exports/gdpdu", { key, body: { year: 2026 } });
    expect(g.status).toBe(202);
    const gid = ((await json(g)) as { job_id: string }).job_id;
    const gjob = await json(await call("GET", `/jobs/${gid}`, { key }));
    expect(gjob).toMatchObject({ kind: "gdpdu_export", actor, status: expect.stringMatching(/queued|running/) });
    const stored = await t.run((ctx) => ctx.db.query("jobs").collect());
    expect(stored[0]?.params).toMatchObject({ year: 2026, includeFiles: true, encoding: "utf8" });

    const age = await call("POST", "/exports/full", { key, body: { encrypt_to_age_recipient: "age1xyz" } });
    expect(age.status).toBe(501);
    const full = await call("POST", "/exports/full", { key, body: {} });
    expect(full.status).toBe(202);

    const other = (await t.asApiKey(["exports:run"], { name: "n8n" })).key;
    expect((await call("GET", `/jobs/${gid}`, { key: other })).status).toBe(404);
    // a read scope also grants the job route (CSV exports), but still only for the key's own jobs
    const reader = (await t.asApiKey(["documents:read"], { name: "reader" })).key;
    expect((await call("GET", `/jobs/${gid}`, { key: reader })).status).toBe(404);
    const noScope = (await t.asApiKey(["company:public"], { name: "web" })).key;
    expect((await call("POST", "/exports/gdpdu", { key: noScope, body: { year: 2026 } })).status).toBe(403);
  });
});
