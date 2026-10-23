import { describe, expect, test } from "vitest";
import { computeEntryHash, genesisHash } from "./chain";
import { chainCheck, decodeCheckpoint, exportSegmentCheck, signatureCheck, summarizeChecks } from "./checkpoint-verify";

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwsOf = (header: unknown, payload: unknown) =>
  `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.c2ln`;

async function chain(n: number, instance = "test") {
  const out: Record<string, unknown>[] = [];
  let prev = await genesisHash(instance);
  for (let seq = 1; seq <= n; seq++) {
    const e: Record<string, unknown> = { seq, at: 1_000 * seq, action: "member.create", prevHash: prev };
    e.hash = await computeEntryHash(prev, e);
    prev = e.hash as string;
    out.push(e);
  }
  return out;
}

const payload = (over: Record<string, unknown> = {}) => ({
  instance: "test",
  date: "2026-10-12",
  lastSeq: 3,
  lastHash: "h3",
  counts: {},
  ...over,
});

describe("checkpoint verification (AUD-017, SEC-04, GOBD-10)", () => {
  test("AUD-017 the JWS is decoded without trusting it: kid from the header, payload fields checked", () => {
    const d = decodeCheckpoint(jwsOf({ alg: "ES256", kid: "abc", typ: "rechnungen-checkpoint+jws" }, payload()));
    expect(d).toMatchObject({ ok: true, kid: "abc", payload: { lastSeq: 3, date: "2026-10-12" } });
    expect(decodeCheckpoint("kein jws")).toEqual({
      ok: false,
      detail: "Die Datei ist kein Prüfpunkt (JWS im Compact-Format erwartet).",
    });
    expect(decodeCheckpoint(jwsOf({ alg: "ES256" }, { date: "x" }))).toEqual({
      ok: false,
      detail: "Die Datei ist kein Prüfpunkt (lastSeq/lastHash/date fehlen).",
    });
    expect(decodeCheckpoint(`  ${jwsOf({ alg: "ES256", kid: "k" }, payload())}\n`).ok).toBe(true);
  });

  test("AUD-017 signature: valid, invalid, or signed with a key that is not configured", () => {
    expect(signatureCheck({ kind: "valid", kid: "abc" })).toEqual({
      id: "signature",
      status: "ok",
      detail: "Signatur gültig (Schlüssel-Fingerabdruck abc).",
    });
    expect(signatureCheck({ kind: "invalid", kid: "abc" })).toMatchObject({
      status: "error",
      detail: "Signatur ungültig – der Prüfpunkt wurde verändert oder nicht von dieser Instanz signiert.",
    });
    expect(signatureCheck({ kind: "unknown_key", kid: "zzz" })).toMatchObject({
      status: "error",
      detail: "Der Schlüssel zzz ist nicht hinterlegt – Signatur kann nicht geprüft werden.",
    });
  });

  test("AUD-017 chain: the current chain must contain lastSeq with lastHash", () => {
    const p = payload();
    expect(chainCheck(p, { seq: 3, hash: "h3" }, { instance: "test", headSeq: 9 })).toEqual({
      id: "chain",
      status: "ok",
      detail: "Die Protokollkette enthält seq 3 mit dem Hash des Prüfpunkts vom 12.10.2026.",
    });
    expect(chainCheck(p, { seq: 3, hash: "anders" }, { instance: "test", headSeq: 9 })).toMatchObject({
      status: "error",
      detail: "Protokolleintrag seq 3 stimmt nicht mit dem Prüfpunkt vom 12.10.2026 überein.",
    });
    expect(chainCheck(p, null, { instance: "test", headSeq: 2 })).toMatchObject({
      status: "error",
      detail: "Der aktuelle Datenstand endet vor dem Prüfpunkt vom 12.10.2026 (seq 2 < 3).",
    });
    expect(chainCheck(p, null, { instance: "test", headSeq: 9, anchorSeq: 5 })).toMatchObject({
      status: "ok",
      detail: "seq 3 liegt im gelöschten Anfangsstück; der signierte Ankerpunkt seq 5 bestätigt die Kette.",
    });
    expect(
      chainCheck(payload({ instance: "andere" }), { seq: 3, hash: "h3" }, { instance: "test", headSeq: 9 }),
    ).toMatchObject({
      id: "instance",
      status: "error",
      detail: "Der Prüfpunkt gehört zur Instanz „andere“, nicht zu „test“.",
    });
  });

  test("AUD-017 offline: an AUD-008 audit export re-verifies up to lastSeq and contains lastHash", async () => {
    const entries = await chain(5);
    const p = payload({ lastSeq: 4, lastHash: entries[3]?.hash });
    expect(await exportSegmentCheck(p, entries)).toEqual({
      id: "chain",
      status: "ok",
      detail:
        "Der Protokollauszug (seq 1–5) ist lückenlos verkettet und enthält seq 4 mit dem Hash des Prüfpunkts vom 12.10.2026.",
    });
    // a modified entry before lastSeq breaks the export
    const tampered = entries.map((e) => (e.seq === 2 ? { ...e, action: "member.disable" } : e));
    expect(await exportSegmentCheck(p, tampered)).toMatchObject({
      status: "error",
      detail: "Protokolleintrag seq 2 wurde verändert oder beschädigt.",
    });
    // the export does not reach lastSeq
    expect(await exportSegmentCheck(payload({ lastSeq: 9, lastHash: "x" }), entries)).toMatchObject({
      status: "error",
      detail: "Der Protokollauszug endet bei seq 5 und enthält seq 9 des Prüfpunkts nicht.",
    });
    // the hash at lastSeq differs
    expect(await exportSegmentCheck(payload({ lastSeq: 4, lastHash: "falsch" }), entries)).toMatchObject({
      status: "error",
      detail: "Protokolleintrag seq 4 stimmt nicht mit dem Prüfpunkt vom 12.10.2026 überein.",
    });
  });

  test("AUD-017 the summary is ok only when every check passed", () => {
    expect(summarizeChecks([{ id: "signature", status: "ok", detail: "x" }])).toEqual({
      ok: true,
      message: "Prüfpunkt bestätigt.",
    });
    expect(
      summarizeChecks([
        { id: "signature", status: "ok", detail: "x" },
        { id: "chain", status: "error", detail: "y" },
      ]),
    ).toEqual({ ok: false, message: "Prüfpunkt nicht bestätigt: y" });
  });
});
