import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { bookingColumns } from "../src/domain/datev/columns";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice, settle } from "./invoices.fixtures";
import { patchCompanyProfile } from "./model/companyProfile";
import { datevExportCount } from "./model/documentHistory";
import { makeT, type TestT } from "./test.setup";

/** F09 EXP-001…016 DATEV export: job, history, re-export (EC-174), acceptance and „Testexport" (EXP-016). */

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}
const cp = new TextDecoder("windows-1252");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const ARGS = {
  from: "2026-10-01",
  to: "2026-10-31",
  scope: ["revenue", "vouchers", "payments", "manual", "master_data", "documents"] as (
    | "revenue"
    | "vouchers"
    | "payments"
    | "manual"
    | "master_data"
    | "documents"
  )[],
  mode: "new" as const,
};

async function withDatev(t: TestT, owner: { actor: `user:${string}` }) {
  await t.model({ actor: owner.actor, role: "owner", channel: "ui" } as const, (ctx) =>
    patchCompanyProfile(
      ctx,
      { datev: { consultantNumber: 1234567, clientNumber: 12345, accountLength: 4, personalAccounts: true } },
      { action: "settings.company.update" },
    ),
  );
}

async function setup(t: TestT) {
  const f = await finalizedInvoice(t);
  await withDatev(t, f.owner);
  return f;
}

async function exportsOf(t: TestT) {
  return t.run((ctx) => ctx.db.query("datevExports").order("asc").collect());
}
async function zipOf(t: TestT, id: Id<"datevExports">) {
  const row = await t.run((ctx) => ctx.db.get(id));
  const buf = await t.run(async (ctx) => (await ctx.storage.get(row?.file.storageId as Id<"_storage">))?.arrayBuffer());
  return unzipSync(new Uint8Array(buf as ArrayBuffer));
}
const dataRows = (csv: Uint8Array | undefined) => cp.decode(csv).split("\r\n").slice(2).filter(Boolean);

describe("DATEV export (F09 EXP-001…016)", { timeout: 180_000 }, () => {
  test("EXP-009 EXP-006 E-EXP-13 TST-EXP-14 EXP-016 export, history, assigned debtor, „Testexport“ until the acceptance is recorded", async () => {
    const t = makeT();
    const f = await setup(t);
    const entries = await t.run((ctx) => ctx.db.query("journalEntries").collect());
    expect(entries.length).toBeGreaterThan(0);

    const report = await f.owner.action(api.datev.validate, ARGS);
    expect(report.blocking).toBe(false);
    expect(report.issues.map((i) => i.message)).toContain(
      "1 Kontakten werden beim Export Debitoren-/Kreditorennummern zugewiesen.",
    );
    expect(report.accepted).toBe(false);

    const { jobId } = await f.owner.mutation(api.datev.start, ARGS);
    await settle(t);
    const job = await t.run((ctx) => ctx.db.get(jobId as Id<"jobs">));
    expect(job?.error).toBeUndefined();
    expect(job?.status).toBe("done");
    expect(job?.resultStorageId).toBeUndefined();

    const [row] = await exportsOf(t);
    expect(row).toMatchObject({ from: "2026-10-01", to: "2026-10-31", isRepeat: false, festschreibung: false });
    // SET-E22: from now on the Sachkontenlänge is locked (settings consult the export history)
    expect(await t.run((ctx) => datevExportCount(ctx))).toBe(1);
    expect(row?.file.name).toBe("DATEV_20261001_20261031_Testexport.zip");
    expect(row?.journalLineIds.length).toBe(entries.reduce((n, e) => n + e.lines.length, 0));
    const zip = await zipOf(t, row?._id as Id<"datevExports">);
    const names = Object.keys(zip).sort();
    expect(names).toContain("EXTF_Buchungsstapel_20261001_20261031.csv");
    expect(names).toContain("EXTF_Debitoren_Kreditoren.csv");
    expect(names).toContain("document.xml");
    expect(names).toContain("manifest.csv");
    expect(names.some((n) => n.startsWith(`${f.number}.`))).toBe(true);
    const csv = zip["EXTF_Buchungsstapel_20261001_20261031.csv"];
    expect(cp.decode(csv).startsWith('"EXTF";700;21;"Buchungsstapel";13;')).toBe(true);
    expect(dataRows(csv).some((r) => r.includes(`"${f.number}"`) && r.includes(";10000;"))).toBe(true);

    // EXP-006: the debtor number was assigned and audited for the member who started the export
    const contact = await t.run((ctx) => ctx.db.get(f.personId as Id<"contacts">));
    const org = await t.run((ctx) => ctx.db.get(f.orgId as Id<"contacts">));
    expect([contact?.debtorAccount, org?.debtorAccount]).toContain("10000");
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((e) => e.action === "contact.account.assign")?.actor).toBe(f.owner.actor);
    expect(audit.find((e) => e.action === "export.datev")?.actor).toBe(f.owner.actor);

    // EXP-016 / E-EXP-18: without acceptance the download needs the „Testexport" confirmation (audited)
    const id = row?._id as Id<"datevExports">;
    expect(dataOf(await catching(f.owner.mutation(api.datev.download, { id }))).message).toBe(
      "DATEV-Import noch nicht von einem Steuerberater bestätigt. Die Datei ist als Testexport gekennzeichnet.",
    );
    const dl = await f.owner.mutation(api.datev.download, { id, testConfirmed: true });
    expect(dl.url).toBeTruthy();
    await f.owner.mutation(api.datev.recordAcceptance, {
      testedOn: "2026-11-01",
      formatVersion: 13,
      buKeysConfirmed: true,
      advisorName: "StB Muster",
    });
    expect((await f.owner.query(api.datev.status, {})).acceptance).toMatchObject({ advisorName: "StB Muster" });
    await f.owner.mutation(api.datev.download, { id });
    const actions = (await t.run((ctx) => ctx.db.query("auditLog").collect())).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["export.datev_test_download", "export.datev_acceptance", "export.datev_download"]),
    );
    // the bookkeeper may export but not record the acceptance
    const bk = await t.asUser("bookkeeper");
    expect(
      dataOf(
        await catching(
          bk.mutation(api.datev.recordAcceptance, { testedOn: "2026-11-01", formatVersion: 13, buKeysConfirmed: true }),
        ),
      ).code,
    ).toBe("forbidden_role");
  });

  test("TST-EXP-08 TST-EXP-11 EC-174 E-EXP-03 E-EXP-09 the delta holds exactly the payment and its reversal (GU = 1); then nothing new", async () => {
    const t = makeT();
    const f = await setup(t);
    await f.owner.mutation(api.datev.start, ARGS);
    await settle(t);
    const before = new Set(
      (await t.run((ctx) => ctx.db.query("journalEntries").collect())).map((e) => e._id as string),
    );

    const pay = await f.owner.mutation(api.payments.recordForInvoice, {
      documentId: f.id,
      source: { kind: "clearing", accountId: f.bankAccount },
      date: "2026-10-12",
      amountCents: 10_000,
    });
    await f.owner.mutation(api.payments.reverse, {
      paymentId: pay.paymentIds[0] as Id<"payments">,
      reason: "Falsch zugeordnet",
    });
    const fresh = (await t.run((ctx) => ctx.db.query("journalEntries").collect())).filter((e) => !before.has(e._id));
    expect(fresh).toHaveLength(2);

    await f.owner.mutation(api.datev.start, ARGS);
    await settle(t);
    const [, second] = await exportsOf(t);
    expect(second?.isRepeat).toBe(true);
    expect(second?.journalLineIds.sort()).toEqual(fresh.flatMap((e) => e.lines.map((_, i) => `${e._id}:${i}`)).sort());
    const zip = await zipOf(t, second?._id as Id<"datevExports">);
    const csv = zip["EXTF_Buchungsstapel_20261001_20261031_2.csv"];
    expect(cp.decode(csv).split("\r\n")[0]).toContain('"Wiederholung 10/2026"');
    const rows = dataRows(csv);
    expect(rows).toHaveLength(2);
    const guAt = bookingColumns(13).indexOf("Generalumkehr");
    const gu = rows.map((r) => r.split(";")[guAt]);
    expect(gu.sort()).toEqual(["", "1"]);

    const { jobId } = await f.owner.mutation(api.datev.start, ARGS);
    await settle(t);
    const job = await t.run((ctx) => ctx.db.get(jobId as Id<"jobs">));
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(
      /^Seit dem letzten Export \(\d{2}\.\d{2}\.2026\) gibt es keine neuen Buchungen in diesem Zeitraum\./,
    );
    expect(await exportsOf(t)).toHaveLength(2);
  });

  test("TST-EXP-10 TST-EXP-09 EXP-011 E-EXP-04 GOBD-06 „Zeitraum festschreiben“ locks the months first (flag 1); the full re-export is identical and „nicht erneut importieren“", async () => {
    const t = makeT();
    const f = await setup(t);
    const preview = await f.owner.action(api.datev.validate, { ...ARGS, lockPeriod: true });
    expect(preview.blocking).toBe(false);
    expect(preview.festschreibung).toBe(1);
    // the plain start has no lock argument; the lock needs its own ⚠ mutation (fresh session)
    await f.owner.mutation(api.datev.startWithLock, ARGS);
    await settle(t);
    const periods = await t.run((ctx) => ctx.db.query("periods").collect());
    expect(periods.find((p) => p.period === "2026-10")).toMatchObject({ status: "locked", reason: "datev_export" });
    const [first] = await exportsOf(t);
    expect(first?.festschreibung).toBe(true);
    const zip1 = await zipOf(t, first?._id as Id<"datevExports">);
    expect(cp.decode(zip1["EXTF_Buchungsstapel_20261001_20261031.csv"]).split("\r\n")[0]).toContain(';1;0;1;"EUR";');

    await f.owner.mutation(api.datev.start, { ...ARGS, mode: "full" });
    await settle(t);
    const [, again] = await exportsOf(t);
    expect(again).toMatchObject({ isRepeat: true, doNotReimport: true, festschreibung: true });
    expect(again?.file.name).toBe("DATEV_20261001_20261031_Wiederholung_nicht_importieren.zip");
    expect(again?.files[0]?.rowsSha256).toBe(first?.files[0]?.rowsSha256);
    const viewer = await t.asUser("viewer");
    expect(dataOf(await catching(viewer.mutation(api.datev.startWithLock, ARGS))).code).toBe("forbidden_role");
  });

  test("E-EXP-01 E-EXP-20 EXP-002 missing keys block, overlapping exports are refused, roles and scopes", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const blocked = await f.owner.action(api.datev.validate, ARGS);
    expect(blocked.blocking).toBe(true);
    expect(blocked.issues.map((i) => i.message)).toContain(
      "Für den DATEV-Export fehlen Berater- und/oder Mandantennummer (Einstellungen › Unternehmen › DATEV).",
    );
    await withDatev(t, f.owner);
    const results = await Promise.allSettled([
      f.owner.mutation(api.datev.start, ARGS),
      f.owner.mutation(api.datev.start, { ...ARGS, from: "2026-10-15" }),
    ]);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(dataOf(rejected[0]?.reason).message).toBe("Für diesen Zeitraum läuft bereits ein Export.");
    await settle(t);

    const bk = await t.asUser("bookkeeper");
    expect((await bk.action(api.datev.validate, ARGS)).blocking).toBe(false);
    const viewer = await t.asUser("viewer");
    expect(dataOf(await catching(viewer.action(api.datev.validate, ARGS))).code).toBe("forbidden_role");
    expect(dataOf(await catching(viewer.query(api.datev.list, {}))).code).toBe("forbidden_role");
    const key = await t.asApiKey(["documents:read"]);
    expect(dataOf(await catching(key.mutation(api.datev.start, ARGS))).code).toBe("forbidden_scope");
  });

  test("E-EXP-10 the DATEV alias is only accepted for numbers DATEV rejects and only in the DATEV character set", async () => {
    const t = makeT();
    const f = await setup(t);
    expect(
      dataOf(await catching(f.owner.mutation(api.datev.setBelegnummer, { documentId: f.id, alias: "RE-1" }))).message,
    ).toBe("Die Belegnummer ist für DATEV bereits gültig.");
  });
});
