import { describe, expect, test } from "vitest";
import { canonicalize } from "./canonical";
import { type ChainEntry, computeEntryHash, genesisHash, sha256Hex, verifyChainPage } from "./chain";

async function buildChain(n: number, instance = "test"): Promise<ChainEntry[]> {
  const out: ChainEntry[] = [];
  let prevHash = await genesisHash(instance);
  for (let seq = 1; seq <= n; seq++) {
    const entry = {
      seq,
      prevHash,
      at: 1_790_000_000_000 + seq,
      actor: "system:test",
      channel: "system",
      action: "test.write",
      entity: { table: "t", id: `id${seq}`, label: `Eintrag ${seq}` }, // findings carry only {table, id}
      diff: { after: { n: seq, nested: { b: true, a: null } } },
    };
    const hash = await computeEntryHash(prevHash, entry);
    out.push({ ...entry, hash });
    prevHash = hash;
  }
  return out;
}

describe("audit hash chain (AUD-004)", () => {
  test("AUD-004 sha256Hex matches the FIPS 180-2 'abc' vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("AUD-004 genesis prevHash is SHA-256('genesis:' + INSTANCE_NAME)", async () => {
    expect(await genesisHash("rechnungen")).toBe(await sha256Hex("genesis:rechnungen"));
  });

  test("AUD-004 hash = SHA-256(prevHash ‖ JCS(entry without hash and system fields))", async () => {
    const entry = { seq: 1, prevHash: "p", b: 2, a: 1, hash: "ignored", _id: "x", _creationTime: 5 };
    expect(await computeEntryHash("p", entry)).toBe(
      await sha256Hex(`p${canonicalize({ a: 1, b: 2, prevHash: "p", seq: 1 })}`),
    );
  });

  test("AUD-004 RI-14 1,000 entries recompute from genesis and verify across pages", async () => {
    const chain = await buildChain(1000);
    let cursor = { nextSeq: 1, prevHash: await genesisHash("test") };
    let last = 0;
    for (let i = 0; i < chain.length; i += 137) {
      const r = await verifyChainPage(chain.slice(i, i + 137), cursor);
      expect(r.findings).toEqual([]);
      cursor = r.cursor;
      last = r.lastVerifiedSeq;
    }
    expect(last).toBe(1000);
    expect(cursor.nextSeq).toBe(1001);
  });

  test("AUD-013 RI-14 a modified diff is reported with the first broken seq (E-AUD-05)", async () => {
    const chain = await buildChain(5);
    const tampered = chain.map((e) => (e.seq === 3 ? { ...e, diff: { after: { n: 999 } } } : e));
    const r = await verifyChainPage(tampered, { nextSeq: 1, prevHash: await genesisHash("test") });
    expect(r.findings).toEqual([
      expect.objectContaining({
        kind: "chain_hash_mismatch",
        severity: "error",
        firstBrokenSeq: 3,
        entity: { table: "t", id: "id3" },
        detail: "Protokolleintrag seq 3 wurde verändert oder beschädigt.",
      }),
    ]);
    expect(r.lastVerifiedSeq).toBe(2);
  });

  test("AUD-013 RI-14 a deleted entry is reported as a gap (E-AUD-04)", async () => {
    const chain = await buildChain(5);
    const r = await verifyChainPage(
      chain.filter((e) => e.seq !== 3),
      { nextSeq: 1, prevHash: await genesisHash("test") },
    );
    expect(r.findings.map((f) => f.kind)).toEqual(["chain_gap", "chain_link_broken"]);
    expect(r.findings[0]?.detail).toBe("Lücke in der Protokollkette zwischen seq 2 und 4.");
  });

  test("AUD-013 RI-14 a re-hashed forgery still breaks the link of the next entry", async () => {
    const chain = await buildChain(4);
    const forged = { ...chain[1], diff: { after: { n: -1 } } } as ChainEntry;
    forged.hash = await computeEntryHash(forged.prevHash, forged);
    const r = await verifyChainPage([chain[0], forged, chain[2], chain[3]] as ChainEntry[], {
      nextSeq: 1,
      prevHash: await genesisHash("test"),
    });
    expect(r.findings).toEqual([expect.objectContaining({ kind: "chain_link_broken", firstBrokenSeq: 3 })]);
  });

  test("AUD-004 a chain started with another instance name does not verify", async () => {
    const chain = await buildChain(2, "other");
    const r = await verifyChainPage(chain, { nextSeq: 1, prevHash: await genesisHash("test") });
    expect(r.findings[0]).toMatchObject({ kind: "chain_link_broken", firstBrokenSeq: 1 });
  });
});
