import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import { clearInvariantTarget } from "../test/invariants";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice } from "./invoices.fixtures";
import { makeT, type TestT } from "./test.setup";

/**
 * Regulatory invariants on the frozen snapshots and the number register (10-edge-cases §2: RI-03, RI-17, RI-18,
 * RI-25, RI-26) wired into `invariants.check`: a correctly finalised invoice raises none of them; tampered data (written
 * past the model layer on purpose) is reported. The pure rules are tested in src/domain/{numbering,tax,einvoice,
 * company}/invariants*.test.ts.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const check = (t: TestT) => t.query(internal.invariants.check, {});
const ids = (list: { id: string }[]) => [...new Set(list.map((v) => v.id))].sort();

async function tamperSnapshot(t: TestT, id: Id<"salesDocuments">, edit: (s: DocumentSnapshot) => DocumentSnapshot) {
  await t.run(async (ctx) => {
    const d = await ctx.db.get(id);
    if (!d?.snapshotId) throw new Error("no snapshot");
    const snap = await ctx.db.get(d.snapshotId);
    if (!snap) throw new Error("no snapshot");
    await ctx.db.patch(d.snapshotId, { json: JSON.stringify(edit(JSON.parse(snap.json) as DocumentSnapshot)) });
  });
  clearInvariantTarget(); // the tampering also breaks RI-01/RI-15 — this test asserts the reported IDs itself
}

describe("RI-03 / RI-17 / RI-18 / RI-25 / RI-26 in invariants.check", () => {
  test("RI-17 RI-18 RI-25 RI-26 RI-03 a correctly finalised GmbH invoice raises none of them", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    const found = (await check(t)).filter((v) => ["RI-03", "RI-17", "RI-18", "RI-25", "RI-26"].includes(v.id));
    expect(found).toEqual([]);
  });

  test("RI-17 a snapshot that claims KU but charges VAT is reported", async () => {
    const t = makeT();
    const { id } = await finalizedInvoice(t);
    await tamperSnapshot(t, id, (s) => ({ ...s, seller: { ...s.seller, kleinunternehmer: true } }));
    const found = (await check(t)).filter((v) => v.id === "RI-17");
    expect(found.map((v) => v.severity)).toContain("ERROR");
  });

  test("RI-26 a GmbH snapshot without register and managing director is reported", async () => {
    const t = makeT();
    const { id } = await finalizedInvoice(t);
    await tamperSnapshot(t, id, (s) => ({ ...s, seller: { ...s.seller, register: undefined, representatives: [] } }));
    expect(ids(await check(t))).toContain("RI-26");
  });

  test("RI-25 an invoice to a public authority without Leitweg-ID is reported", async () => {
    const t = makeT();
    const { id } = await finalizedInvoice(t);
    await tamperSnapshot(t, id, (s) => ({
      ...s,
      buyer: { ...s.buyer, isPublicAuthority: true },
      references: { ...s.references, buyerReference: undefined },
    }));
    expect(ids(await check(t))).toContain("RI-25");
  });

  test("RI-18 a MUST_E document whose effective mark handed over no e-invoice is reported", async () => {
    const t = makeT();
    const { id } = await finalizedInvoice(t);
    await t.run(async (ctx) => {
      const d = await ctx.db.get(id);
      if (!d?.einvoice) throw new Error("no einvoice");
      await ctx.db.patch(id, { einvoice: { ...d.einvoice, decision: "MUST_E" } });
      const pdf = (
        await ctx.db
          .query("documentArtifacts")
          .withIndex("by_document", (q) => q.eq("documentId", id))
          .collect()
      )[0];
      if (!pdf) throw new Error("no artifact");
      await ctx.db.insert("sendLog", {
        documentId: id,
        purpose: "document",
        kind: "mark_sent",
        sentOn: "2026-10-12",
        channel: "post",
        artifacts: [{ artifactId: pdf._id, sha256: pdf.sha256 }],
        at: Date.now(),
        actor: "user:test-owner",
      });
    });
    clearInvariantTarget();
    const found = (await check(t)).filter((v) => v.id === "RI-18");
    expect(found.map((v) => v.message).join("\n")).toContain("nicht elektronisch als E-Rechnung übergeben");
  });

  test("RI-03 a register row whose counter does not increase is a WARN", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("numberRegister").collect()).find((r) => r.docType === "invoice");
      if (!row) throw new Error("no register row");
      const { _id, _creationTime, ...rest } = row;
      await ctx.db.insert("numberRegister", { ...rest, number: `${row.number}-X`, normalized: `${row.normalized}X` });
    });
    clearInvariantTarget();
    const found = (await check(t)).filter((v) => v.id === "RI-03");
    expect(found).toEqual([
      expect.objectContaining({ severity: "WARN", message: expect.stringContaining("steigt nicht") }),
    ]);
  });
});
