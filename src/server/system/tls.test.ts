import { describe, expect, test } from "vitest";
import { certificateCheck } from "@/domain/system/security";
import { certificateValidTo, type TlsConnect } from "./tls";

describe("certificate expiry probe (E-AUD-30b)", () => {
  test("E-AUD-30b the served certificate's expiry feeds the < 14 days check; an unreachable host is unknown", async () => {
    const seen: unknown[] = [];
    const soon: TlsConnect = (opts, done) => {
      seen.push(opts);
      done({ valid_to: "Oct 20 12:00:00 2026 GMT" });
    };
    const validTo = await certificateValidTo("app.buero.example.de", { connect: soon });
    expect(seen).toEqual([
      { host: "app.buero.example.de", port: 443, servername: "app.buero.example.de", timeoutMs: 3000 },
    ]);
    expect(validTo).toBe(Date.UTC(2026, 9, 20, 12));
    expect(certificateCheck({ baseDomain: "buero.example.de", validTo }, Date.UTC(2026, 9, 12))).toMatchObject({
      status: "error",
      detail: "Das Zertifikat für *.buero.example.de läuft am 20.10.2026 ab.",
    });
    const down: TlsConnect = (_o, done) => done(null);
    expect(await certificateValidTo("app.x.de", { connect: down })).toBeNull();
  });
});
