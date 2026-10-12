import { describe, expect, test } from "vitest";
import {
  APPEND_ONLY_TABLES,
  assertMutable,
  changedFields,
  IMMUTABILITY_MATRIX,
  ImmutableRecordError,
} from "./immutability";

const entry = { _id: "a1", _creationTime: 1, seq: 1, hash: "h", diff: { after: { x: 1 } } };

describe("immutability matrix (03 §11)", () => {
  test("AUD-005 audit entries cannot be updated, replaced or deleted (E-AUD-02)", () => {
    expect(() => assertMutable("auditLog", entry, { op: "patch", patch: { hash: "forged" } })).toThrow(
      ImmutableRecordError,
    );
    expect(() => assertMutable("auditLog", entry, { op: "replace", next: { seq: 1, hash: "h", diff: {} } })).toThrow(
      "immutable_record",
    );
    try {
      assertMutable("auditLog", entry, { op: "delete" });
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: "immutable_record", messageDe: "Protokolleinträge sind unveränderlich." });
    }
  });

  test("AUD-010 a no-op patch on an append-only row is allowed (nothing changes)", () => {
    expect(() => assertMutable("auditLog", entry, { op: "patch", patch: { seq: 1 } })).not.toThrow();
  });

  test.each(APPEND_ONLY_TABLES.map((t) => [t]))("AUD-010 %s is append-only", (table) => {
    expect(() => assertMutable(table, { _id: "x", a: 1 }, { op: "patch", patch: { a: 2 } })).toThrow(
      "immutable_record",
    );
    expect(() => assertMutable(table, { _id: "x", a: 1 }, { op: "delete" })).toThrow("immutable_record");
  });

  test("AUD-010 unprotected tables (members, invites, settings) are freely mutable", () => {
    expect(() =>
      assertMutable("members", { role: "viewer" }, { op: "patch", patch: { role: "bookkeeper" } }),
    ).not.toThrow();
    expect(() => assertMutable("invites", { email: "a" }, { op: "delete" })).not.toThrow();
  });

  test("AUD-010 integrityRuns acknowledgement fields may be set once, everything else is frozen", () => {
    const run = { _id: "r", ok: false, findings: [] };
    expect(() =>
      assertMutable("integrityRuns", run, {
        op: "patch",
        patch: { acknowledgedAt: 5, acknowledgedNote: "Ursache: Test", acknowledgedBy: "user:u1" },
      }),
    ).not.toThrow();
    const acked = { ...run, acknowledgedAt: 5 };
    expect(() => assertMutable("integrityRuns", acked, { op: "patch", patch: { acknowledgedAt: 6 } })).toThrow(
      "may be set only once",
    );
    expect(() => assertMutable("integrityRuns", run, { op: "patch", patch: { ok: true } })).toThrow("ok is frozen");
  });

  test("AUD-010 contactKeys: the wrapped key can only be removed (shredding), shreddedAt set once", () => {
    const key = { _id: "k", contactId: "c", wrappedKey: "w", createdAt: 1 };
    expect(() =>
      assertMutable("contactKeys", key, { op: "patch", patch: { wrappedKey: undefined, shreddedAt: 9 } }),
    ).not.toThrow();
    expect(() => assertMutable("contactKeys", key, { op: "patch", patch: { wrappedKey: "other" } })).toThrow(
      "may only be removed",
    );
    expect(() => assertMutable("contactKeys", key, { op: "patch", patch: { contactId: "d" } })).toThrow("frozen");
  });

  test("AUD-010 numberRegister and periods follow their transitions only", () => {
    expect(() =>
      assertMutable("numberRegister", { status: "issued" }, { op: "patch", patch: { status: "cancelled_by_storno" } }),
    ).not.toThrow();
    expect(() =>
      assertMutable("numberRegister", { status: "cancelled_by_storno" }, { op: "patch", patch: { status: "issued" } }),
    ).toThrow("transition status cancelled_by_storno → issued");
    expect(() => assertMutable("periods", { status: "open" }, { op: "patch", patch: { status: "locked" } })).toThrow(
      "transition",
    );
    expect(() => assertMutable("periods", { status: "locked" }, { op: "delete" })).toThrow("delete");
  });

  test("AUD-016 integrityCheckpoints record the upload result after the signed row exists", () => {
    const cp = { _id: "c", jws: "x", uploadStatus: "pending" };
    expect(() =>
      assertMutable("integrityCheckpoints", cp, {
        op: "patch",
        patch: { uploadStatus: "uploaded", exportedTo: "r2://cp/checkpoints/2026/10/12.jws" },
      }),
    ).not.toThrow();
    expect(() =>
      assertMutable(
        "integrityCheckpoints",
        { ...cp, uploadStatus: "uploaded" },
        { op: "patch", patch: { uploadStatus: "failed" } },
      ),
    ).toThrow("transition");
    expect(() => assertMutable("integrityCheckpoints", cp, { op: "patch", patch: { jws: "forged" } })).toThrow(
      "frozen",
    );
  });

  test("AUD-010 changedFields ignores system fields and compares structurally", () => {
    const before = { _id: "x", _creationTime: 1, a: { b: [1, 2] }, c: 1 };
    expect([...changedFields(before, { op: "patch", patch: { a: { b: [1, 2] } } }).keys()]).toEqual([]);
    expect([...changedFields(before, { op: "replace", next: { a: { b: [1, 2] } } }).keys()]).toEqual(["c"]);
  });

  test("AUD-010 every protected table rule is well-formed", () => {
    for (const [table, rule] of Object.entries(IMMUTABILITY_MATRIX)) {
      if (rule.kind === "guarded") expect(Object.keys(rule.fields ?? {}).length, table).toBeGreaterThan(0);
    }
  });
  test("DOC-29 UST-30 T-DOC-019 a finalised sales document changes only along the 03 §11 whitelist", () => {
    const draft = { _id: "d", _creationTime: 1, status: "draft", subject: "a" };
    expect(() => assertMutable("salesDocuments", draft, { op: "patch", patch: { subject: "b" } })).not.toThrow();
    expect(() => assertMutable("salesDocuments", draft, { op: "delete" })).not.toThrow();
    const fin = { ...draft, status: "finalized", number: "RE-1", artifactStatus: "pending" };
    expect(() => assertMutable("salesDocuments", fin, { op: "patch", patch: { subject: "b" } })).toThrow("frozen");
    expect(() => assertMutable("salesDocuments", fin, { op: "patch", patch: { number: "RE-2" } })).toThrow("frozen");
    expect(() => assertMutable("salesDocuments", fin, { op: "delete" })).toThrow("delete");
    expect(() => assertMutable("salesDocuments", fin, { op: "patch", patch: { status: "draft" } })).toThrow(
      "transition",
    );
    expect(() =>
      assertMutable("salesDocuments", fin, { op: "patch", patch: { status: "sent", sentAt: 5, sentOn: "2026-10-12" } }),
    ).not.toThrow();
    expect(() =>
      assertMutable("salesDocuments", fin, { op: "patch", patch: { artifactStatus: "ready" } }),
    ).not.toThrow();
    expect(() =>
      assertMutable(
        "salesDocuments",
        { ...fin, artifactStatus: "ready" },
        { op: "patch", patch: { artifactStatus: "pending" } },
      ),
    ).toThrow("transition");
    expect(() =>
      assertMutable("salesDocuments", { ...fin, firstExportedAt: 1 }, { op: "patch", patch: { firstExportedAt: 2 } }),
    ).toThrow("once");
  });

  test("DOC-29 document lines are frozen with their parent", () => {
    const line = { _id: "l", _creationTime: 1, name: "A", quantityMilli: 1000 };
    expect(() =>
      assertMutable("documentLines", { ...line, parentStatus: "draft" }, { op: "patch", patch: { name: "B" } }),
    ).not.toThrow();
    expect(() =>
      assertMutable("documentLines", { ...line, parentStatus: "sent" }, { op: "patch", patch: { name: "B" } }),
    ).toThrow("frozen");
    expect(() => assertMutable("documentLines", { ...line, parentStatus: "finalized" }, { op: "delete" })).toThrow(
      "delete",
    );
  });
});
