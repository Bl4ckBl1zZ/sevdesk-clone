import { exportJWK, exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { describe, expect, test } from "vitest";
import { loadCheckpointKey, signCheckpoint } from "../../convex/lib/jws";
import { computeEntryHash, genesisHash } from "../../src/domain/audit/chain";
import { auditJson } from "../../src/domain/audit/viewer";
import { type CliIo, verifyCheckpointCli } from "./verify-checkpoint";

async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const key = await loadCheckpointKey(await exportPKCS8(privateKey));
  const entries: Record<string, unknown>[] = [];
  let prev = await genesisHash("prod");
  for (let seq = 1; seq <= 6; seq++) {
    const e: Record<string, unknown> = { seq, at: seq, action: "member.create", prevHash: prev };
    e.hash = await computeEntryHash(prev, e);
    prev = e.hash as string;
    entries.push(e);
  }
  const jws = await signCheckpoint(
    { instance: "prod", date: "2026-10-19", lastSeq: 4, lastHash: entries[3]?.hash, counts: {} },
    key,
  );
  const files: Record<string, string> = {
    "19.jws": `${jws}\n`,
    "pub.pem": await exportSPKI(publicKey),
    "pub.jwk.json": JSON.stringify(await exportJWK(publicKey)),
    "audit.json": auditJson(entries, { instance: "prod", exportedAt: 0, filter: {} as never }),
  };
  const io: CliIo = {
    env: {},
    readText: async (p) => {
      const f = files[p];
      if (f === undefined) throw new Error(`ENOENT ${p}`);
      return f;
    },
  };
  return { key, entries, files, io };
}

describe("pnpm integrity:verify-checkpoint (AUD-017)", () => {
  test("AUD-017 offline: signature with the public key and the chain from an AUD-008 export; the fingerprint is printed", async () => {
    const { key, io } = await fixture();
    const r = await verifyCheckpointCli(["19.jws", "--public-key", "pub.pem", "--audit-export", "audit.json"], io);
    expect(r.exitCode).toBe(0);
    expect(r.lines).toEqual(
      expect.arrayContaining([
        "Prüfpunkt vom 19.10.2026 · bis seq 4 · Instanz prod",
        `Schlüssel-Fingerabdruck (kid) des Prüfpunkts: ${key.kid}`,
        `✓ Signatur gültig (Schlüssel-Fingerabdruck ${key.kid}).`,
        "✓ Der Protokollauszug (seq 1–6) ist lückenlos verkettet und enthält seq 4 mit dem Hash des Prüfpunkts vom 19.10.2026.",
        "Prüfpunkt bestätigt.",
      ]),
    );
    // a JWK file works the same way
    expect(
      (await verifyCheckpointCli(["19.jws", "--public-key", "pub.jwk.json", "--audit-export", "audit.json"], io))
        .exitCode,
    ).toBe(0);
  });

  test("AUD-017 a tampered export or a foreign key is not confirmed (exit 1); a missing argument is a usage error (exit 2)", async () => {
    const { entries, files, io } = await fixture();
    files["bad.json"] = auditJson(
      entries.map((e) => (e.seq === 3 ? { ...e, action: "member.disable" } : e)),
      { instance: "prod", exportedAt: 0, filter: {} as never },
    );
    const tampered = await verifyCheckpointCli(["19.jws", "--public-key", "pub.pem", "--audit-export", "bad.json"], io);
    expect(tampered.exitCode).toBe(1);
    expect(tampered.lines).toContain("✗ Protokolleintrag seq 3 wurde verändert oder beschädigt.");

    const other = await generateKeyPair("ES256", { extractable: true });
    files["other.pem"] = await exportSPKI(other.publicKey);
    const foreign = await verifyCheckpointCli(
      ["19.jws", "--public-key", "other.pem", "--audit-export", "audit.json"],
      io,
    );
    expect(foreign.exitCode).toBe(1);
    expect(
      foreign.lines.some(
        (l) =>
          l.startsWith("✗ Der Schlüssel") && l.endsWith("ist nicht hinterlegt – Signatur kann nicht geprüft werden."),
      ),
    ).toBe(true);

    expect((await verifyCheckpointCli([], io)).exitCode).toBe(2);
    expect((await verifyCheckpointCli(["19.jws"], io)).lines).toContain(
      "Kein öffentlicher Schlüssel: --public-key angeben.",
    );
  });

  test("AUD-017 without a chain source only the signature is confirmed (exit 1); --convex uses the live chain", async () => {
    const { entries, io } = await fixture();
    const sigOnly = await verifyCheckpointCli(["19.jws", "--public-key", "pub.pem"], io);
    expect(sigOnly.exitCode).toBe(1);
    expect(sigOnly.lines.at(-1)).toBe("Signatur bestätigt (Kette nicht geprüft).");

    const live: CliIo = {
      ...io,
      convexChain: async (seq) => ({
        entry: { seq, hash: entries[seq - 1]?.hash as string },
        headSeq: 6,
      }),
    };
    const online = await verifyCheckpointCli(["--checkpoint", "19.jws", "--public-key", "pub.pem", "--convex"], live);
    expect(online.exitCode).toBe(0);
    expect(online.lines).toContain("✓ Die Protokollkette enthält seq 4 mit dem Hash des Prüfpunkts vom 19.10.2026.");
  });
});
