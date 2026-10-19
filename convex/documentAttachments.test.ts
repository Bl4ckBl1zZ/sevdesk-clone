import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sha256Hex } from "../src/domain/audit/chain";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createValues, orgForm, PARIS } from "./catalog.fixtures";
import { b2bBuyer, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};

const PDF = "%PDF-1.7\nAGB der Musterfirma\n%%EOF";

const store = (t: TestT, content: string, type: string) =>
  t.run((ctx) => ctx.storage.store(new Blob([content], { type })));

const xmlOf = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => {
    const a = (await ctx.db.query("documentArtifacts").collect()).find(
      (x) => x.documentId === id && x.kind === "xrechnung_xml",
    );
    const blob = a ? await ctx.storage.get(a.storageId) : null;
    return blob ? await blob.arrayBuffer() : null;
  });

describe("DOC-18 document attachments", { timeout: 30_000 }, () => {
  test("DOC-18 a draft attachment is frozen in the snapshot, travels with the ZIP and is embedded as BG-24", async () => {
    const t = makeT();
    const setup = await setupInvoicing(t);
    const { personId } = await b2bBuyer(setup.owner);
    const { owner } = setup;
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const storageId = await store(t, PDF, "application/pdf");
    await owner.mutation(api.invoices.addAttachment, { id, storageId, name: "agb.pdf", embedInXml: true });
    const txt = await store(t, "Notiz", "text/plain");
    const notEmbeddable = await owner
      .mutation(api.invoices.addAttachment, { id, storageId: txt, name: "notiz.txt", embedInXml: true })
      .catch((x: unknown) => x);
    expect(dataOf(notEmbeddable).reason).toBe("ATTACHMENT_NOT_EMBEDDABLE");
    await owner.mutation(api.invoices.addAttachment, { id, storageId: txt, name: "notiz.txt" });
    await owner.mutation(api.invoices.updateAttachment, {
      id,
      sha256: await sha256Hex(new TextEncoder().encode("Notiz")),
      includeInExport: false,
    });
    const exe = await store(t, "MZ", "application/octet-stream");
    const bad = await owner
      .mutation(api.invoices.addAttachment, { id, storageId: exe, name: "tool.exe" })
      .catch((x: unknown) => x);
    expect(dataOf(bad).reason).toBe("ATTACHMENT_INVALID");

    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);

    const hash = await sha256Hex(new TextEncoder().encode(PDF));
    const snapshot = await t.run(async (ctx) => {
      const d = await ctx.db.get(id);
      const s = d?.snapshotId ? await ctx.db.get(d.snapshotId) : null;
      return s ? (JSON.parse(s.json) as DocumentSnapshot) : null;
    });
    expect(snapshot?.attachments).toEqual([
      { name: "agb.pdf", mime: "application/pdf", sha256: hash, embedInXml: true },
      { name: "notiz.txt", mime: "text/plain", sha256: expect.any(String), embedInXml: false },
    ]);

    const zip = await owner.action(api.documentArtifacts.exportFiles, { id, request: { entry: "zip" } });
    expect(zip.attachments).toEqual([
      { name: "Anlagen/agb.pdf", url: expect.any(String), sha256: hash, mime: "application/pdf" },
    ]);
    const single = await owner.action(api.documentArtifacts.exportFiles, { id, request: { entry: "default" } });
    expect(single.attachments).toEqual([]);

    const xml = new TextDecoder().decode((await xmlOf(t, id)) ?? new ArrayBuffer(0));
    expect(xml).toContain('filename="agb.pdf"');
    expect(xml).toContain(btoa(PDF));
    expect(xml).not.toContain("notiz.txt");

    // Frozen: no change after finalisation.
    const late = await owner
      .mutation(api.invoices.addAttachment, { id, storageId: exe, name: "spaet.pdf" })
      .catch((x: unknown) => x);
    expect(errorCode(late)).toBe("immutable_record");
    expect(dataOf(late).reason).toBe("ATTACHMENTS_FROZEN");
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.files.attachments.map((a) => a.name)).toEqual(["agb.pdf", "notiz.txt"]);
  });
});

describe("INV-30 proof attachments", { timeout: 30_000 }, () => {
  test("INV-30 UST-21 T-INV-024 a finalised intra-Community supply shows proof_missing_igl until a Gelangensbestätigung is attached", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const fr = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Société Exemple SARL", { vatId: "FR40303265045" }), {
        address: { ...PARIS },
        email: "factures@exemple.fr",
      }),
    });
    const base = invoiceValues(fr.id);
    const values = {
      ...base,
      lines: base.lines.map((l) => (l.kind === "item" ? { ...l, productType: "good" as const, unitCode: "H87" } : l)),
      taxCaseOverride: { taxCase: "intra_community_supply" as const, reason: "Lieferung nach Frankreich" },
      deliveryAddress: { name: "Société Exemple SARL", ...PARIS },
    };
    const { id } = await owner.mutation(api.invoices.createDraft, { values });
    await owner.action(api.invoices.finalize, {
      id,
      version: 1,
      overrides: { vatCheck: { reason: "Prüfung wird nachgeholt" } },
    });
    await settle(t);
    expect((await t.run((ctx) => ctx.db.get(id)))?.taxCase).toBe("intra_community_supply");
    expect((await owner.query(api.invoices.get, { id }))?.files.proofWarning?.code).toBe("proof_missing_igl");

    const other = await store(t, PDF, "application/pdf");
    await owner.mutation(api.invoices.addEvidence, { id, storageId: other, name: "lieferschein.pdf", kind: "other" });
    expect((await owner.query(api.invoices.get, { id }))?.files.proofWarning?.code).toBe("proof_missing_igl");

    const proof = await store(t, `${PDF} GB`, "application/pdf");
    await owner.mutation(api.invoices.addEvidence, {
      id,
      storageId: proof,
      name: "gelangensbestaetigung.pdf",
      kind: "gelangensbestaetigung",
      note: "unterschrieben zurück",
    });
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.files.proofWarning).toBeNull();
    expect(detail?.files.evidence.map((e) => e.kind)).toEqual(["other", "gelangensbestaetigung"]);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.filter((a) => a.action === "document.evidence_add" && a.entity.id === id)).toHaveLength(2);
    // Proofs are not part of the snapshot; the snapshot is unchanged.
    const d = await t.run((ctx) => ctx.db.get(id));
    const snap = await t.run(async (ctx) => (d?.snapshotId ? await ctx.db.get(d.snapshotId) : null));
    expect(snap?.json).not.toContain("gelangensbestaetigung");
  });

  test("INV-30 proofs are refused on drafts", async () => {
    const t = makeT();
    const setup = await setupInvoicing(t);
    const { personId } = await b2bBuyer(setup.owner);
    const { id } = await setup.owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const storageId = await store(t, PDF, "application/pdf");
    const e = await setup.owner
      .mutation(api.invoices.addEvidence, { id, storageId, name: "cmr.pdf", kind: "cmr" })
      .catch((x: unknown) => x);
    expect(dataOf(e).reason).toBe("EVIDENCE_DRAFT");
  });
});
