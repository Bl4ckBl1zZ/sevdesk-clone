import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PERMISSIONS, type Permission, type PermissionRule } from "../src/domain/access/permissions";
import { GDPDU_DTD_SHA256 } from "../src/domain/gdpdu/dtd";
import { validateIndexXml } from "../src/domain/gdpdu/write";
import { ABLAUFHEMMUNG_ITEMS, PURGE_PHRASE } from "../src/domain/privacy/purge";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice, settle } from "./invoices.fixtures";
import { memoryCheckpointObjects } from "./lib/checkpointStore";
import { makeT, type TestT } from "./test.setup";

/** F09 EXP-017…019 (GDPdU Z3, GOBD-11) and F12 AUD-023 (auditor Z1 read-only, year scope, Z3 downloads). */

const inventory = JSON.parse(readFileSync(new URL("./mutation-inventory.json", import.meta.url), "utf8"));

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}
const td = new TextDecoder();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
  memoryCheckpointObjects.clear();
});
afterEach(() => {
  vi.useRealTimers();
  memoryCheckpointObjects.clear();
});

async function packageOf(t: TestT, id: Id<"gdpduExports">) {
  const row = await t.run((ctx) => ctx.db.get(id));
  const buf = await t.run(async (ctx) => (await ctx.storage.get(row?.storageId as Id<"_storage">))?.arrayBuffer());
  return unzipSync(new Uint8Array(buf as ArrayBuffer));
}

describe("GDPdU Z3 export (EXP-017, EXP-018, GOBD-11)", { timeout: 120_000 }, () => {
  test("TST-EXP-16 EXP-017 EXP-018 GOBD-11 E-EXP-33 the 2026 package validates against the DTD, counts match the DB, amounts use the decimal comma", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    // E-EXP-33: a restricted contact is still exported (statutory access)
    const req = await f.owner.mutation(api.dsgvo.create, {
      contactId: f.personId,
      kind: "restriction",
      channel: "email",
      receivedAt: "2026-10-10",
    });
    await f.owner.mutation(api.dsgvo.verify, { id: req, method: "E-Mail" });
    await f.owner.mutation(api.dsgvo.execute, { id: req });
    const { jobId } = await f.owner.mutation(api.gdpdu.start, { year: 2026, encoding: "utf8", includeFiles: true });
    await settle(t);
    const job = await t.run((ctx) => ctx.db.get(jobId as Id<"jobs">));
    expect(job?.error).toBeUndefined();
    expect(job?.status).toBe("done");
    const [row] = await f.owner.query(api.gdpdu.list, {});
    expect(row).toMatchObject({ year: 2026, name: "gdpdu-2026.zip" });
    const zip = await packageOf(t, row?.id as Id<"gdpduExports">);
    const xml = td.decode(zip["index.xml"]);
    expect(validateIndexXml(xml)).toEqual([]);
    const { createHash } = await import("node:crypto");
    expect(
      createHash("sha256")
        .update(zip["gdpdu-01-09-2004.dtd"] as Uint8Array)
        .digest("hex"),
    ).toBe(GDPDU_DTD_SHA256);

    const entries = await t.run((ctx) => ctx.db.query("journalEntries").collect());
    const lines = await t.run((ctx) => ctx.db.query("journalLines").collect());
    const records = (file: string) => td.decode(zip[file]).split("\r\n").filter(Boolean);
    expect(records("buchungen.csv")).toHaveLength(entries.length);
    expect(records("buchungszeilen.csv")).toHaveLength(lines.length);
    const readme = td.decode(zip["README.txt"]);
    expect(readme).toContain(`- buchungen.csv (Buchungen): ${entries.length}`);
    expect(readme).toContain("Gesperrte Kontakte (Art. 18 DSGVO) sind enthalten");
    const rechnung = records("rechnungen.csv").find((r) => r.includes(`"${f.number}"`));
    expect(rechnung).toMatch(/;\d+,\d{2};\d+,\d{2};\d+,\d{2};/);
    expect(records("kontakte.csv").some((r) => r.includes(`"${f.personId}"`) && r.endsWith('"ja"'))).toBe(true);
    // belege/ holds the original PDF referenced from dokumente.csv
    const doc = records("dokumente.csv").find((r) => r.includes('"pdf"') || r.includes('"zugferd_pdf"'));
    const path = /"belege\/([^"]+)"/.exec(doc ?? "")?.[1];
    expect(path && zip[`belege/${path}`]).toBeTruthy();
    // every journal account is in konten.csv (foreign key)
    const konten = new Set(records("konten.csv").map((r) => r.split(";")[0]?.replaceAll('"', "")));
    for (const l of lines) expect(konten.has(l.account)).toBe(true);
    // the export is audited for the owner
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((e) => e.action === "export.gdpdu")?.actor).toBe(f.owner.actor);
  });

  test("EXP-018 the ANSI variant declares <ANSI/> and writes Windows-1252", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    await f.owner.mutation(api.gdpdu.start, { year: 2026, encoding: "ansi", includeFiles: false });
    await settle(t);
    const [row] = await f.owner.query(api.gdpdu.list, {});
    const zip = await packageOf(t, row?.id as Id<"gdpduExports">);
    expect(td.decode(zip["index.xml"])).toContain("<ANSI/>");
    expect(Object.keys(zip).some((k) => k.startsWith("belege/"))).toBe(false);
    expect(row?.name).toBe("gdpdu-2026-ansi.zip");
  });

  test("EXP-017 owner and bookkeeper start it (02 §4.3), not the viewer; API keys need exports:run; a future year is refused", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const viewer = await t.asUser("viewer");
    const args = { year: 2026, encoding: "utf8" as const, includeFiles: false };
    expect(dataOf(await catching(viewer.mutation(api.gdpdu.start, args))).code).toBe("forbidden_role");
    const bk = await t.asUser("bookkeeper");
    await expect(bk.mutation(api.gdpdu.start, args)).resolves.toMatchObject({ jobId: expect.any(String) });
    await settle(t);
    const key = await t.asApiKey(["documents:read"]);
    expect(dataOf(await catching(key.mutation(api.gdpdu.start, args))).code).toBe("forbidden_scope");
    expect(dataOf(await catching(f.owner.mutation(api.gdpdu.start, { ...args, year: 2027 }))).message).toBe(
      "Bitte ein Wirtschaftsjahr zwischen 2000 und dem laufenden Jahr wählen.",
    );
    await settle(t);
  });

  test("TST-EXP-18 E-EXP-34 GOBD-21 after a purge the rows are absent, the tombstones are in protokoll.csv and README lists the batch", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    await settle(t);
    vi.setSystemTime(new Date("2035-01-02T10:00:00Z"));
    const owner = await t.asUser("owner", { existingUserId: f.owner.userId });
    await owner.mutation(api.retention.startPurge, {
      classes: ["vouchers8"],
      years: [],
      checklist: Object.fromEntries(ABLAUFHEMMUNG_ITEMS.map((i) => [i.id, true])),
      phrase: PURGE_PHRASE,
    });
    await settle(t);
    await owner.mutation(api.gdpdu.start, { year: 2026, encoding: "utf8", includeFiles: false });
    await settle(t);
    const [row] = await owner.query(api.gdpdu.list, {});
    const zip = await packageOf(t, row?.id as Id<"gdpduExports">);
    expect(td.decode(zip["rechnungen.csv"])).not.toContain(`"${f.number}"`);
    expect(td.decode(zip["protokoll.csv"])).toContain('"retention.purge"');
    expect(td.decode(zip["README.txt"])).toMatch(/02\.01\.2035 Lauf .+: \d+ Datensätze/);
    // the journal (10 years) is still complete
    expect(td.decode(zip["buchungen.csv"]).length).toBeGreaterThan(0);
  });
});

describe("auditor Z1 access (AUD-023)", { timeout: 120_000 }, () => {
  test("AUD-023 the auditor sees only the granted fiscal years and downloads the Z3 package of those years (audited)", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    await f.owner.mutation(api.gdpdu.start, { year: 2026, encoding: "utf8", includeFiles: false });
    await settle(t);
    const a2025 = await t.asUser("auditor", { auditor: { purpose: "Az 1", fiscalYears: [2025] } });
    expect(await a2025.query(api.invoices.get, { id: f.id as Id<"salesDocuments"> })).toBeNull();
    const list25 = await a2025.query(api.invoices.list, { paginationOpts: { numItems: 50, cursor: null } });
    expect(list25.page).toEqual([]);
    expect(await a2025.query(api.gdpdu.list, {})).toEqual([]);
    const a2026 = await t.asUser("auditor", { auditor: { purpose: "Az 2", fiscalYears: [2026] } });
    expect(await a2026.query(api.invoices.get, { id: f.id as Id<"salesDocuments"> })).not.toBeNull();
    // master data stays visible (needed to understand the granted year)
    expect(await a2026.query(api.contacts.get, { id: f.personId })).not.toBeNull();
    const [pkg] = await a2026.query(api.gdpdu.list, {});
    expect(pkg?.year).toBe(2026);
    const dl = await a2026.mutation(api.gdpdu.download, { id: pkg?.id as Id<"gdpduExports"> });
    expect(dl.url).toBeTruthy();
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((e) => e.action === "export.gdpdu_download")?.actor).toBe(a2026.actor);
    expect(dataOf(await catching(a2025.mutation(api.gdpdu.download, { id: pkg?.id as Id<"gdpduExports"> }))).code).toBe(
      "not_found",
    );
  });

  test("AUD-023 TST-AUD-22 route table: no public mutation that writes business data admits the auditor; real calls answer forbidden_role", async () => {
    const offenders = Object.entries(
      inventory as Record<string, { kind: string; visibility: string; permission?: string }>,
    )
      .filter(([, e]) => e.kind === "mutation" && e.visibility === "public" && e.permission)
      .filter(([, e]) => {
        const rule: PermissionRule = PERMISSIONS[e.permission as Permission];
        return rule.roles.includes("auditor") && rule.write;
      })
      .map(([name]) => name);
    expect(offenders).toEqual([]);
    const t = makeT();
    const f = await finalizedInvoice(t);
    const auditor = await t.asUser("auditor", { auditor: { purpose: "Az 1", fiscalYears: [2026] } });
    expect(
      dataOf(await catching(auditor.mutation(api.gdpdu.start, { year: 2026, encoding: "utf8", includeFiles: false })))
        .code,
    ).toBe("forbidden_role");
    expect(
      dataOf(await catching(auditor.mutation(api.contacts.create, { values: { kind: "person", lastName: "X" } }))).code,
    ).toBe("forbidden_role");
    expect(
      dataOf(await catching(auditor.mutation(api.invoices.createDraft, { values: { contactId: f.personId } }))).code,
    ).toBe("forbidden_role");
    expect(dataOf(await catching(auditor.query(api.dsgvo.list, {}))).code).toBe("forbidden_role");
    expect(dataOf(await catching(auditor.query(api.retention.worklist, {}))).code).toBe("forbidden_role");
  });
});
