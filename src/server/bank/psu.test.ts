import { describe, expect, test } from "vitest";
import { psuFromHeaders } from "./psu";

const h = (o: Record<string, string>) => (n: string) => o[n] ?? null;

describe("PSU headers (BNK-107)", () => {
  test("BNK-107 the owner's address and user agent are forwarded from the edge headers", () => {
    expect(
      psuFromHeaders(h({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "10.0.0.1", "user-agent": "Safari" })),
    ).toEqual({ psuIpAddress: "203.0.113.7", psuUserAgent: "Safari" });
    expect(psuFromHeaders(h({ "x-forwarded-for": "100.64.0.3, 172.18.0.2" }))).toEqual({ psuIpAddress: "100.64.0.3" });
    expect(psuFromHeaders(h({ "x-forwarded-for": "<script>" }))).toEqual({});
  });
});
