import { describe, expect, test } from "vitest";
import { canSplitOrMerge, mergeFiles, SPLIT_MERGE_MESSAGES, splitFiles, splitParts } from "./split-merge";

const f = (name: string, role = "original", derivedFrom?: number) => ({
  name,
  sha256: `h-${name}`,
  role,
  ...(derivedFrom !== undefined ? { derivedFrom } : {}),
});

describe("INB-009 split / merge (pure)", () => {
  test("INB-009 GOBD-08 split: each part keeps its files unchanged (same hash); derived files follow their parent; the .eml goes with every part", () => {
    const files = [
      f("mail.eml", "eml"),
      f("a.pdf", "original", 0),
      f("a.xml", "extracted_xml", 1),
      f("b.pdf", "original", 0),
    ];
    expect(splitParts(files)).toEqual([1, 3]);
    const r = splitFiles(files, [[1], [3]]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([
      [f("mail.eml", "eml"), f("a.pdf", "original", 0), f("a.xml", "extracted_xml", 1)],
      [f("mail.eml", "eml"), f("b.pdf", "original", 0)],
    ]);
    // Without an e-mail: plain uploads, derivedFrom re-indexed into the new item.
    const up = [f("1.jpg"), f("2.pdf"), f("2.xml", "extracted_xml", 1)];
    const u = splitFiles(up, [[0], [1]]);
    expect(u.ok && u.value).toEqual([[f("1.jpg")], [f("2.pdf"), f("2.xml", "extracted_xml", 0)]]);
  });

  test("INB-009 split needs at least two groups, every part exactly once", () => {
    const files = [f("1.jpg"), f("2.jpg"), f("3.jpg")];
    expect(splitFiles([f("1.jpg")], [[0]])).toMatchObject({
      ok: false,
      error: { message: SPLIT_MERGE_MESSAGES.splitOne },
    });
    expect(splitFiles(files, [[0, 1, 2]])).toMatchObject({
      ok: false,
      error: { message: SPLIT_MERGE_MESSAGES.splitGroups },
    });
    expect(splitFiles(files, [[0], [0, 1, 2]])).toMatchObject({
      ok: false,
      error: { message: SPLIT_MERGE_MESSAGES.splitGroups },
    });
    expect(splitFiles(files, [[0], [1]])).toMatchObject({
      ok: false,
      error: { message: SPLIT_MERGE_MESSAGES.splitGroups },
    });
    expect(splitFiles(files, [[0], []])).toMatchObject({ ok: false });
    expect(splitFiles(files, [[0, 2], [1]]).ok).toBe(true);
  });

  test("INB-009 merge: files of all items in the given order (front, then back), derivedFrom shifted", () => {
    const r = mergeFiles([[f("front.jpg")], [f("back.pdf"), f("back.xml", "extracted_xml", 0)]]);
    expect(r).toMatchObject({ ok: true, value: [f("front.jpg"), f("back.pdf"), f("back.xml", "extracted_xml", 1)] });
    expect(mergeFiles([[f("x.jpg")]])).toMatchObject({ ok: false, error: { message: SPLIT_MERGE_MESSAGES.mergeTwo } });
  });

  test("INB-009 only open items whose draft is still a draft can be split or merged", () => {
    expect(canSplitOrMerge({ status: "needs_review", voucherStatus: "draft", emlPending: false })).toBeNull();
    expect(canSplitOrMerge({ status: "duplicate", emlPending: false })).toBeNull();
    expect(canSplitOrMerge({ status: "new", emlPending: false })).toBeNull();
    for (const status of ["converted", "rejected", "superseded", "processing"] as const) {
      expect(canSplitOrMerge({ status, emlPending: false })).toBe(SPLIT_MERGE_MESSAGES.state);
    }
    expect(canSplitOrMerge({ status: "needs_review", voucherStatus: "open", emlPending: false })).toBe(
      SPLIT_MERGE_MESSAGES.booked,
    );
    expect(canSplitOrMerge({ status: "new", emlPending: true })).toBe(SPLIT_MERGE_MESSAGES.emlPending);
  });
});
