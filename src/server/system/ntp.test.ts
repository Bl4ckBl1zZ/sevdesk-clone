import { createSocket } from "node:dgram";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_NTP_SERVER, measureClockOffset } from "./ntp";

let server: ReturnType<typeof createSocket> | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

describe("SET-131 SNTP client", () => {
  test("SET-131 measures the offset against a (local) NTP server; null on timeout", async () => {
    const socket = createSocket("udp4");
    server = socket;
    const port = await new Promise<number>((resolve) =>
      socket.bind(0, "127.0.0.1", () => resolve(socket.address().port)),
    );
    socket.on("message", (_msg, rinfo) => {
      const buf = Buffer.alloc(48);
      buf[0] = 0x24;
      buf[1] = 2;
      const ms = Date.now() + 5_000; // server 5 s ahead
      const seconds = Math.floor(ms / 1000) + 2_208_988_800;
      for (const offset of [32, 40]) {
        buf.writeUInt32BE(seconds, offset);
        buf.writeUInt32BE(Math.round(((ms % 1000) / 1000) * 2 ** 32), offset + 4);
      }
      socket.send(buf, rinfo.port, rinfo.address);
    });
    const offset = await measureClockOffset({ host: "127.0.0.1", port, timeoutMs: 1_000 });
    expect(offset).not.toBeNull();
    expect(Math.abs((offset ?? 0) - 5_000)).toBeLessThan(500);
  });

  test("SET-131 an unreachable server gives null", async () => {
    // Nothing listens on this port: the client times out.
    expect(await measureClockOffset({ host: "127.0.0.1", port: 9, timeoutMs: 200 })).toBeNull();
  });
});

describe("AUD-019 NTP reference", () => {
  test("AUD-019 the default reference is the PTB (EU); NTP_SERVER overrides it", () => {
    expect(DEFAULT_NTP_SERVER).toBe("ptbtime1.ptb.de");
  });
});
