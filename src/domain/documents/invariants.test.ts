import { describe, expect, test } from "vitest";
import {
  checkDocumentNumbers,
  checkFinalisedDocument,
  checkSentMarks,
  checkTotals,
  type DocumentInvariantRow,
} from "./invariants";
import type { SnapshotTotals } from "./snapshot";

const totals = (patch: Partial<SnapshotTotals> = {}): SnapshotTotals => ({
  lineNetSumCents: 10_000,
  allowanceTotalCents: 0,
  chargeTotalCents: 0,
  netCents: 10_000,
  vatCents: 1_900,
  grossCents: 11_900,
  advancesDeductedGrossCents: 0,
  roundingCents: 0,
  payableCents: 11_900,
  byGroup: [
    {
      category: "S",
      rateBp: 1900,
      lineNetSumCents: 10_000,
      allowanceCents: 0,
      chargeCents: 0,
      baseCents: 10_000,
      vatCents: 1_900,
    },
  ],
  ...patch,
});

const finalised = (patch: Partial<DocumentInvariantRow> = {}): DocumentInvariantRow => ({
  id: "d1",
  type: "invoice",
  status: "finalized",
  number: "RE-2026-0001",
  documentDate: "2026-10-12",
  hasSupplyDate: true,
  retentionUntil: "2034-12-31",
  artifactStatus: "ready",
  snapshot: { present: true, hashMatches: true, number: "RE-2026-0001" },
  artifacts: [{ id: "a1", sha256: "ab", storedSha256: "ab" }],
  ...patch,
});

describe("RI-01 finalised documents are complete", () => {
  test("RI-01 a complete finalised invoice passes", () => {
    expect(checkFinalisedDocument(finalised())).toEqual([]);
  });

  test("RI-01 flags a missing number, snapshot, date, supply date and retention", () => {
    const out = checkFinalisedDocument(
      finalised({
        number: undefined,
        documentDate: undefined,
        hasSupplyDate: false,
        retentionUntil: undefined,
        snapshot: { present: false, hashMatches: false },
      }),
    );
    expect(out.map((f) => f.id)).toEqual(["RI-01", "RI-01", "RI-01", "RI-01", "RI-01"]);
  });

  test("RI-01 flags a snapshot whose hash no longer verifies", () => {
    const out = checkFinalisedDocument(
      finalised({ snapshot: { present: true, hashMatches: false, number: "RE-2026-0001" } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toMatch(/snapshotHash/);
  });

  test("RI-01 flags an artifact whose stored bytes no longer match the archived sha256", () => {
    const out = checkFinalisedDocument(finalised({ artifacts: [{ id: "a1", sha256: "ab", storedSha256: "cd" }] }));
    expect(out).toHaveLength(1);
    const missing = checkFinalisedDocument(finalised({ artifacts: [{ id: "a1", sha256: "ab", storedSha256: null }] }));
    expect(missing).toHaveLength(1);
  });

  test("RI-01 requires archived artifacts once ready, but not while pending or blocked", () => {
    expect(checkFinalisedDocument(finalised({ artifacts: [] }))).toHaveLength(1);
    expect(checkFinalisedDocument(finalised({ artifacts: [], artifactStatus: "pending" }))).toEqual([]);
    expect(checkFinalisedDocument(finalised({ artifacts: [], artifactStatus: "blocked" }))).toEqual([]);
  });

  test("RI-01 drafts are not checked", () => {
    expect(checkFinalisedDocument(finalised({ status: "draft", number: undefined, snapshot: undefined }))).toEqual([]);
  });
});

describe("RI-02 numbers", () => {
  test("RI-02 a draft with a number is an error", () => {
    const out = checkDocumentNumbers([finalised({ status: "draft" })], []);
    expect(out.some((f) => /Entwurf/.test(f.message))).toBe(true);
  });

  test("RI-02 every issued number points to exactly one finalised document and vice versa", () => {
    const ok = checkDocumentNumbers(
      [finalised()],
      [{ number: "RE-2026-0001", normalized: "RE20260001", documentId: "d1" }],
    );
    expect(ok).toEqual([]);
    const missing = checkDocumentNumbers([finalised()], []);
    expect(missing).toHaveLength(1);
    const orphan = checkDocumentNumbers([], [{ number: "RE-2026-0001", normalized: "RE20260001", documentId: "d9" }]);
    expect(orphan).toHaveLength(1);
    const dup = checkDocumentNumbers(
      [finalised()],
      [
        { number: "RE-2026-0001", normalized: "RE20260001", documentId: "d1" },
        { number: "RE-2026-0001", normalized: "RE20260001", documentId: "d1" },
      ],
    );
    expect(dup.length).toBeGreaterThan(0);
  });

  test("RI-02 imported register rows (opening numbers) need no document", () => {
    expect(checkDocumentNumbers([], [{ number: "A-1", normalized: "A1", imported: true }])).toEqual([]);
  });
});

describe("RI-05 totals", () => {
  test("RI-05 consistent totals pass", () => {
    expect(checkTotals("RE-1", [10_000], totals())).toEqual([]);
  });

  test("RI-05 Σ line nets must equal the line net sum", () => {
    expect(checkTotals("RE-1", [9_999], totals())).toHaveLength(1);
  });

  test("RI-05 VAT per group is round_half_up(base × rate)", () => {
    const g = totals().byGroup[0];
    if (!g) throw new Error("fixture");
    const out = checkTotals("RE-1", [10_000], totals({ byGroup: [{ ...g, vatCents: 1_901 }] }));
    expect(out.some((f) => /USt-Gruppe/.test(f.message))).toBe(true);
  });

  test("RI-05 gross = net + VAT and payable = gross − advances", () => {
    expect(checkTotals("RE-1", [10_000], totals({ grossCents: 11_901 })).length).toBeGreaterThan(0);
    expect(checkTotals("RE-1", [10_000], totals({ payableCents: 11_000 }))).toHaveLength(1);
    expect(checkTotals("RE-1", [10_000], totals({ advancesDeductedGrossCents: 900, payableCents: 11_000 }))).toEqual(
      [],
    );
  });

  test("RI-05 net = line net sum − allowances + charges", () => {
    expect(checkTotals("RE-1", [10_000], totals({ netCents: 9_000 })).length).toBeGreaterThan(0);
  });
});

describe("RI-19 sent marks", () => {
  test("RI-19 a sent document needs an effective mark whose hashes equal archived artifacts", () => {
    const doc = { id: "d1", number: "RE-1", status: "sent" as const, finalizedOn: "2026-10-12" };
    const artifacts = [{ id: "a1", sha256: "ab", storedSha256: "ab" }];
    const mark = {
      id: "m1",
      kind: "mark_sent" as const,
      sentOn: "2026-10-12",
      recordedOn: "2026-10-12",
      at: 1,
      artifacts: [{ artifactId: "a1", sha256: "ab" }],
    };
    expect(checkSentMarks(doc, [mark], artifacts)).toEqual([]);
    expect(checkSentMarks(doc, [], artifacts)).toHaveLength(1);
    const retraction = {
      id: "r1",
      kind: "retraction" as const,
      retractsId: "m1",
      sentOn: "2026-10-12",
      recordedOn: "2026-10-12",
      at: 2,
      artifacts: [],
    };
    expect(checkSentMarks(doc, [mark, retraction], artifacts)).toHaveLength(1);
    expect(checkSentMarks(doc, [{ ...mark, artifacts: [{ artifactId: "a1", sha256: "zz" }] }], artifacts)).toHaveLength(
      1,
    );
  });

  test("RI-19 sentOn lies between the finalisation date and the recording date", () => {
    const doc = { id: "d1", number: "RE-1", status: "sent" as const, finalizedOn: "2026-10-12" };
    const artifacts = [{ id: "a1", sha256: "ab", storedSha256: "ab" }];
    const base = { id: "m1", kind: "mark_sent" as const, at: 1, artifacts: [{ artifactId: "a1", sha256: "ab" }] };
    expect(checkSentMarks(doc, [{ ...base, sentOn: "2026-10-11", recordedOn: "2026-10-12" }], artifacts)).toHaveLength(
      1,
    );
    expect(checkSentMarks(doc, [{ ...base, sentOn: "2026-10-13", recordedOn: "2026-10-12" }], artifacts)).toHaveLength(
      1,
    );
  });

  test("RI-19 documents that are not sent are not checked", () => {
    expect(
      checkSentMarks({ id: "d1", number: "RE-1", status: "finalized", finalizedOn: "2026-10-12" }, [], []),
    ).toEqual([]);
  });
});

describe("EC-190 F09 IMP-003 imported archive documents in the invariants", () => {
  test("EC-190 RI-01 an imported document needs no snapshot and no supply date, but number, date, retention and artifact hashes still hold", () => {
    const imported = finalised({
      status: "sent",
      imported: true,
      hasSupplyDate: false,
      snapshot: { present: false, hashMatches: false },
      artifacts: [{ id: "a1", sha256: "abc", storedSha256: "abc" }],
    });
    expect(checkFinalisedDocument(imported)).toEqual([]);
    const { retentionUntil: _r, ...noRetention } = imported;
    const broken = { ...noRetention, artifacts: [{ id: "a1", sha256: "abc", storedSha256: "xyz" }] };
    expect(checkFinalisedDocument(broken).map((f) => f.message)).toEqual([
      "RE-2026-0001: keine Aufbewahrungsfrist.",
      "RE-2026-0001: Prüfsumme der Datei a1 stimmt nicht.",
    ]);
    // the exemption is for imported records only
    expect(checkFinalisedDocument({ ...imported, imported: false }).length).toBeGreaterThan(0);
  });

  test("EC-190 RI-19 §4.3.3 an imported sent document has no sendLog proof and is not flagged", () => {
    expect(checkSentMarks({ id: "d1", number: "RE-1", status: "sent", imported: true }, [], [])).toEqual([]);
    expect(checkSentMarks({ id: "d1", number: "RE-1", status: "sent" }, [], []).map((f) => f.id)).toEqual(["RI-19"]);
  });
});
