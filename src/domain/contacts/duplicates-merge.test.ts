import { describe, expect, test } from "vitest";
import {
  compareCandidates,
  type DuplicateCandidate,
  findDuplicateHints,
  findDuplicatePairs,
  jaroWinkler,
  normalizeName,
  pairKey,
} from "./duplicates";
import { checkUndo, datevMergeWarning, type MergeContact, mergedValues, resolveAlias, validateMerge } from "./merge";

const cand = (over: Partial<DuplicateCandidate> & { id: string }): DuplicateCandidate => ({
  displayName: "X",
  invoiceEmails: [],
  ...over,
});

describe("CON-130 CON-131 duplicates", () => {
  test("T-CON-050 'Müller GmbH' vs 'Mueller GmbH' with the same postal code → hint", () => {
    expect(normalizeName("Müller GmbH")).toBe("mueller");
    expect(normalizeName("Mueller G.m.b.H.")).not.toBe("");
    expect(normalizeName("Schmidt & Söhne GmbH & Co. KG")).toBe("schmidt soehne");
    const a = cand({ id: "a", displayName: "Müller GmbH", postalCode: "10115" });
    const b = cand({ id: "b", displayName: "Mueller GmbH", postalCode: "10115" });
    expect(compareCandidates(a, b)).toEqual({ id: "b", score: 1, reasons: ["name"] });
    expect(compareCandidates(a, { ...b, postalCode: "80331" })).toBeNull();
  });

  test("CON-130 Jaro-Winkler ≥ 0.92 counts; unrelated names do not", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961, 3);
    expect(jaroWinkler("dwayne", "duane")).toBeCloseTo(0.84, 2);
    expect(jaroWinkler("", "x")).toBe(0);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
    const a = cand({ id: "a", displayName: "Bäckerei Schulze", postalCode: "1" });
    expect(compareCandidates(a, cand({ id: "b", displayName: "Baeckerei Schulz", postalCode: "1" }))?.reasons).toEqual([
      "name",
    ]);
    expect(compareCandidates(a, cand({ id: "c", displayName: "Metzgerei Huber", postalCode: "1" }))).toBeNull();
  });

  test("CON-130 same VAT ID, invoice e-mail or IBAN are hints with score 1", () => {
    const a = cand({ id: "a", vatId: "ATU12345678", invoiceEmails: ["R@x.at"], iban: "AT611904300234573201" });
    const b = cand({ id: "b", vatId: "ATU12345678", invoiceEmails: ["r@x.at"], iban: "AT611904300234573201" });
    expect(compareCandidates(a, b)?.reasons).toEqual(["vat_id", "invoice_email", "iban"]);
    expect(compareCandidates(a, a)).toBeNull();
    expect(findDuplicateHints(a, [b, cand({ id: "c" })])).toHaveLength(1);
  });

  test("CON-131 pairs are listed once and dismissed pairs never return", () => {
    const all = [
      cand({ id: "b", displayName: "Müller GmbH", postalCode: "10115", vatId: "DE123456788" }),
      cand({ id: "a", displayName: "Mueller GmbH", postalCode: "10115", vatId: "DE123456788" }),
      cand({ id: "c", displayName: "Andere AG", postalCode: "10115" }),
    ];
    const pairs = findDuplicatePairs(all);
    expect(pairs).toEqual([{ a: "a", b: "b", score: 1, reasons: ["vat_id", "name"] }]);
    expect(pairKey("b", "a")).toEqual(["a", "b"]);
    expect(findDuplicatePairs(all, new Set(["a|b"]))).toEqual([]);
  });
});

const mc = (over: Partial<MergeContact> & { id: string }): MergeContact => ({
  kind: "organization",
  status: "active",
  displayName: over.id,
  fields: {},
  tags: [],
  customFields: {},
  ...over,
});

describe("CON-132 … CON-135 merge", () => {
  test("T-CON-052 organisation and person → MERGE_KIND_MISMATCH", () => {
    expect(validateMerge(mc({ id: "w" }), [mc({ id: "l", kind: "person" })])?.message).toBe(
      "Nur Kontakte desselben Typs (Organisation/Person) können zusammengeführt werden.",
    );
  });

  test("§5.8 winner archived/merged/restricted, loser merged, self merge, empty list", () => {
    expect(validateMerge(mc({ id: "w", status: "archived" }), [mc({ id: "l" })])?.code).toBe("MERGE_WINNER_INVALID");
    expect(validateMerge(mc({ id: "w", restrictedAt: 1 }), [mc({ id: "l" })])?.code).toBe("MERGE_WINNER_INVALID");
    expect(validateMerge(mc({ id: "w" }), [mc({ id: "l", mergedIntoId: "x" })])?.code).toBe("MERGE_LOSER_INVALID");
    expect(validateMerge(mc({ id: "w" }), [mc({ id: "w" })])?.code).toBe("MERGE_SAME_CONTACT");
    expect(validateMerge(mc({ id: "w" }), [])?.code).toBe("MERGE_NO_LOSER");
  });

  test("§5.8 different VAT IDs need confirmation", () => {
    const w = mc({ id: "w", fields: { vatId: "ATU12345678" } });
    const l = mc({ id: "l", fields: { vatId: "ATU87654321" } });
    expect(validateMerge(w, [l])?.code).toBe("MERGE_VAT_CONFLICT");
    expect(validateMerge(w, [l], true)).toBeNull();
    expect(validateMerge(w, [mc({ id: "l2", fields: { vatId: "ATU12345678" } })])).toBeNull();
  });

  test("CON-132 field choices (winner by default), tag union, custom fields with winner precedence", () => {
    const w = mc({ id: "w", fields: { iban: "W", notes: "w" }, tags: ["t1"], customFields: { a: 1, b: 2 } });
    const l = mc({ id: "l", fields: { iban: "L", notes: "l" }, tags: ["t2", "t1"], customFields: { b: 9, c: 3 } });
    const r = mergedValues(w, [l], { iban: "l", notes: "w" }, { b: "l" });
    expect(r.fields).toEqual({ iban: "L" });
    expect(r.tags).toEqual(["t1", "t2"]);
    expect(r.customFields).toEqual({ a: 1, b: 9, c: 3 });
  });

  test("T-CON-051 CON-134 undo impossible after a moved draft was finalised", () => {
    expect(checkUndo(0, false)).toBeNull();
    expect(checkUndo(2, false)?.message).toBe(
      "Rückgängig nicht mehr möglich: 2 übernommene Entwürfe wurden inzwischen fertiggestellt.",
    );
    expect(checkUndo(0, true)?.code).toBe("MERGE_ALREADY_UNDONE");
  });

  test("CON-135 DATEV warning only for exported loser accounts", () => {
    expect(datevMergeWarning("10007", true)).toBe(
      "Personenkonto 10007 wurde bereits an DATEV übergeben — offene Posten bitte in der Buchhaltung umbuchen.",
    );
    expect(datevMergeWarning("10007", false)).toBeNull();
    expect(datevMergeWarning(undefined, true)).toBeNull();
  });

  test("T-CON-072 CON-133 aliases resolve to the final winner (chains, cycles)", () => {
    const map: Record<string, string> = { a: "b", b: "c", x: "y", y: "x" };
    expect(resolveAlias("a", (id) => map[id])).toBe("c");
    expect(resolveAlias("c", (id) => map[id])).toBe("c");
    expect(["x", "y"]).toContain(resolveAlias("x", (id) => map[id]));
  });
});
