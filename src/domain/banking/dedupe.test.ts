import { describe, expect, test } from "vitest";
import { bankFixture, SYNTH } from "../../../test/fixtures/bank/load";
import { bankTxId, type Candidate, dedupeKeys, type ExistingBankRow, planImport, toCandidates } from "./dedupe";
import { parseStatement } from "./statement";
import type { BankSourceKind, ParsedTransaction } from "./types";

const ACC = "acc1";

async function load(file: string) {
  const r = parseStatement(bankFixture(`${SYNTH}/${file}`), { fileName: file });
  if (!r.ok) throw new Error(r.error.message);
  return { st: r.value, candidates: await toCandidates(ACC, r.value.transactions) };
}

/** What the Convex layer stores after inserting the `new` items of a plan. */
function persist(kind: BankSourceKind, candidates: readonly Candidate[], existing: ExistingBankRow[] = []) {
  const plan = planImport({ accountId: ACC, kind, candidates, existing });
  const rows = [...existing];
  for (const it of plan.items) {
    if (it.kind === "new") {
      rows.push({
        id: `tx${rows.length + 1}`,
        dedupeKey: it.dedupeKey,
        contentHash: it.tx.contentHash,
        bookingDate: it.tx.bookingDate,
        amountCents: it.tx.amountCents,
        currency: it.tx.currency,
        ...(it.tx.counterpartyName ? { counterpartyName: it.tx.counterpartyName } : {}),
        ...(it.tx.counterpartyIban ? { counterpartyIban: it.tx.counterpartyIban } : {}),
        bankTxIds: bankTxId(it.tx) ? [bankTxId(it.tx) as string] : [],
        sourceKinds: [kind],
        rawSha256s: [it.tx.rawSha256],
      });
    }
    if (it.kind === "merge") {
      const i = rows.findIndex((r) => r.id === it.existingId);
      const r = rows[i] as ExistingBankRow;
      rows[i] = {
        ...r,
        ...it.enrich,
        bankTxIds: [...r.bankTxIds, ...(bankTxId(it.tx) ? [bankTxId(it.tx) as string] : [])],
        sourceKinds: [...r.sourceKinds, kind],
      };
    }
  }
  return { plan, rows };
}

const tx = (over: Partial<ParsedTransaction> = {}): ParsedTransaction => ({
  line: 1,
  bookingDate: "2026-10-07",
  amountCents: -380,
  currency: "EUR",
  purpose: "Cafe Einstein",
  counterpartyName: "Cafe Einstein",
  raw: "{}",
  ...over,
});

describe("dedupe (BNK-109, BNK-110, BNK-034)", () => {
  test("T07-049 EC-BNK-45 the same file twice inserts nothing the second time", async () => {
    const { candidates } = await load("eur-2026-10.camt053.xml");
    const first = persist("camt053", candidates);
    expect(first.plan.counts.new).toBe(13);
    const again = persist("camt053", candidates, first.rows);
    expect(again.plan.counts).toMatchObject({ new: 0, duplicates: 13, merged: 0, possibleDuplicates: 0 });
  });

  test("T07-045 T07-142 EC-148 EC-BNK-43 CAMT then the Revolut CSV of the same month: 0 new, every row merged by ID", async () => {
    const camt = await load("eur-2026-10.camt053.xml");
    const csv = await load("eur-2026-10.csv");
    const { rows } = persist("camt053", camt.candidates);
    const plan = planImport({ accountId: ACC, kind: "revolut_csv", candidates: csv.candidates, existing: rows });
    expect(plan.counts).toMatchObject({ total: 13, new: 0, merged: 13, conflicts: 0, possibleDuplicates: 0 });
    // The month-end row is 2026-10-31 in CAMT (UTC date) but 2026-11-01 in the CSV (Berlin) — still one booking.
    const last = plan.items[12];
    expect(last?.kind).toBe("merge");
  });

  test("T07-049 EC-BNK-46 two genuine identical coffees in one file stay two rows; a superset re-import adds only the surplus", async () => {
    const a = tx();
    const one = await toCandidates(ACC, [a, { ...a, line: 2 }]);
    expect(dedupeKeys(ACC, one)).toEqual([`${ACC}:h:${one[0]?.contentHash}:0`, `${ACC}:h:${one[0]?.contentHash}:1`]);
    const first = persist("mt940", one);
    expect(first.plan.counts.new).toBe(2);
    const superset = await toCandidates(ACC, [a, { ...a, line: 2 }, { ...a, line: 3 }]);
    const second = persist("mt940", superset, first.rows);
    expect(second.plan.counts).toMatchObject({ new: 1, duplicates: 2 });
  });

  test("T07-028 EC-BNK-15 BNK-113 a re-delivered booked row with a different amount is a conflict, never applied", async () => {
    const [c] = await toCandidates(ACC, [tx({ entryReference: "R1" })]);
    const { rows } = persist("camt053", [c as Candidate]);
    const [changed] = await toCandidates(ACC, [tx({ entryReference: "R1", amountCents: -480 })]);
    const plan = planImport({ accountId: ACC, kind: "camt053", candidates: [changed as Candidate], existing: rows });
    expect(plan.items[0]).toMatchObject({ kind: "conflict", fields: ["Betrag"] });
  });

  test("T07-044 BNK-031 a later source fills empty counterparty fields once via the merge", async () => {
    const [c] = await toCandidates(ACC, [tx({ entryReference: "R2", counterpartyName: undefined, purpose: "x" })]);
    const { rows } = persist("camt053", [c as Candidate]);
    const [later] = await toCandidates(ACC, [
      tx({
        providerTransactionId: "R2",
        counterpartyName: "Cafe Einstein",
        counterpartyIban: "DE89370400440532013000",
      }),
    ]);
    const plan = planImport({ accountId: ACC, kind: "revolut_csv", candidates: [later as Candidate], existing: rows });
    expect(plan.items[0]).toMatchObject({
      kind: "merge",
      enrich: { counterpartyName: "Cafe Einstein", counterpartyIban: "DE89370400440532013000" },
    });
    const filled = persist("revolut_csv", [later as Candidate], rows).rows;
    const [third] = await toCandidates(ACC, [tx({ entryReference: "R2", counterpartyName: "Anders" })]);
    const plan3 = planImport({ accountId: ACC, kind: "mt940", candidates: [third as Candidate], existing: filled });
    expect(plan3.items[0]).toMatchObject({ kind: "merge", enrich: {} });
  });

  test("T07-142 EC-BNK-77 BNK-034 cross-source rows without a common ID go to „Mögliche Dubletten“, nothing is inserted", async () => {
    const camt = await load("eur-2026-10.camt053.xml");
    const mt = await load("eur-2026-10.mt940.txt");
    const { rows } = persist("camt053", camt.candidates);
    const plan = planImport({ accountId: ACC, kind: "mt940", candidates: mt.candidates, existing: rows });
    // Fee and exchange rows carry identical content (no counterparty, same text) → merged by content hash.
    expect(plan.counts).toMatchObject({ new: 0, merged: 2, possibleDuplicates: 11 });
    const coffee = plan.items[3];
    expect(coffee).toMatchObject({ kind: "possible_duplicate", reason: "near_duplicate" });
    if (coffee?.kind === "possible_duplicate") expect(coffee.existingIds).toHaveLength(2);
  });

  test("EC-192 BNK-109 same content hash on the same day: one existing row → merge, two → review list", async () => {
    const [c1, c2] = await toCandidates(ACC, [tx(), tx({ line: 2 })]);
    const rows = persist("mt940", [c1 as Candidate, c2 as Candidate]).rows;
    const [csvRow] = await toCandidates(ACC, [tx()]);
    const plan = planImport({ accountId: ACC, kind: "csv", candidates: [csvRow as Candidate], existing: rows });
    expect(plan.items[0]).toMatchObject({ kind: "possible_duplicate", reason: "content_hash" });
    const single = persist("mt940", [c1 as Candidate]).rows;
    const plan1 = planImport({ accountId: ACC, kind: "csv", candidates: [csvRow as Candidate], existing: single });
    expect(plan1.items[0]).toMatchObject({ kind: "merge", by: "content_hash" });
  });

  test("RI-29 an overlapping statement inserts only the rows outside the already imported period", async () => {
    const oct = await load("eur-2026-10.camt053.xml");
    const overlap = await load("eur-2026-10-23_2026-11-05.overlap.camt053.xml");
    const { rows } = persist("camt053", oct.candidates);
    const plan = planImport({ accountId: ACC, kind: "camt053", candidates: overlap.candidates, existing: rows });
    expect(plan.counts).toMatchObject({ total: 4, duplicates: 2, new: 2 });
  });
});
