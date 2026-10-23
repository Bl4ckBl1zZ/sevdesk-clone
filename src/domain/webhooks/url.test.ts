import { describe, expect, test } from "vitest";
import { addressAllowed, checkEndpointUrl, classifyAddress, isIpLiteral, URL_MESSAGES } from "./url";

describe("webhook SSRF guard — address classes (API-031, 05 §5.1)", () => {
  test("API-031 documentation, benchmark and protocol ranges are reserved; their neighbours are public", () => {
    const reserved = [
      "192.0.0.8",
      "192.0.2.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.7",
      "203.0.113.9",
      "240.0.0.1",
    ];
    for (const ip of reserved) expect(classifyAddress(ip), ip).toBe("reserved");
    const neighbours = [
      "192.0.1.1",
      "198.17.0.1",
      "198.20.0.1",
      "198.51.101.1",
      "198.52.100.1",
      "203.0.114.1",
      "203.1.113.1",
    ];
    for (const ip of neighbours) expect(classifyAddress(ip), ip).toBe("public");
  });

  test("API-031 malformed IPv4 literals are no addresses (octet > 255, wrong number of parts)", () => {
    expect(classifyAddress("256.1.1.1")).toBe("invalid");
    expect(classifyAddress("1.2.3")).toBe("invalid");
    expect(isIpLiteral("example.com")).toBe(false);
    expect(addressAllowed("999.1.1.1", false)).toBe(false);
  });

  test("API-031 IPv6: zone IDs are ignored, embedded IPv4 is judged by the IPv4, malformed literals are invalid", () => {
    expect(classifyAddress("fe80::1%eth0")).toBe("link_local");
    expect(classifyAddress("::ffff:192.168.1.1")).toBe("private");
    expect(classifyAddress("::ffff:8.8.8.8")).toBe("public");
    expect(classifyAddress("::127.0.0.1")).toBe("loopback");
    expect(classifyAddress("64:ff9b::10.0.0.1")).toBe("private");
    expect(classifyAddress("::ffff:300.1.1.1")).toBe("invalid");
    expect(classifyAddress("1::2::3")).toBe("invalid");
    expect(classifyAddress("2001:db8:zz::1")).toBe("invalid");
    expect(classifyAddress("1:2:3:4:5:6:7")).toBe("invalid");
    expect(classifyAddress("1:2:3:4::5:6:7:8")).toBe("invalid");
    expect(classifyAddress("1:2:3:4:5:6:7:8")).toBe("public");
    expect(classifyAddress("2a00:1450:4001:82a::200e")).toBe("public");
  });

  test("API-031 IPv6 documentation and discard ranges are reserved; 6to4 is judged by its IPv4", () => {
    expect(classifyAddress("2001:db8::1")).toBe("reserved");
    expect(classifyAddress("2001:db9::1")).toBe("public");
    expect(classifyAddress("100::1")).toBe("reserved");
    expect(classifyAddress("100:0:0:1::1")).toBe("public");
    expect(classifyAddress("ff02::1")).toBe("reserved");
    expect(classifyAddress("2002:c0a8:0101::1")).toBe("private");
    expect(classifyAddress("2002:0808:0808::1")).toBe("public");
    expect(classifyAddress("[fd7a:115c:a1e0::1]")).toBe("tailnet");
  });
});

describe("webhook endpoint URL check (API-031)", () => {
  test("API-031 URLs longer than 2 000 characters are refused", () => {
    const long = `https://hooks.example.com/${"a".repeat(2000)}`;
    expect(checkEndpointUrl(long, true)).toEqual({ ok: false, error: URL_MESSAGES.length });
  });

  test("API-031 an http(s) URL without host is invalid; a public IP literal is allowed in production", () => {
    expect(checkEndpointUrl("https://", true)).toEqual({ ok: false, error: URL_MESSAGES.invalid });
    expect(checkEndpointUrl("https://8.8.8.8/hook", true)).toEqual({ ok: true, url: "https://8.8.8.8/hook" });
    expect(checkEndpointUrl("https://[2001:db8::1]/hook", true)).toEqual({ ok: false, error: URL_MESSAGES.local });
  });
});
