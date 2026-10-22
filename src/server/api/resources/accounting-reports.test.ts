import { api } from "@convex/_generated/api";
import { describe, expect, test } from "vitest";
import { sha256Hex } from "@/domain/audit/chain";
import { accountingReportsResource } from "./accounting-reports";

/** F09 EXP-020 Kennzahlen sheet as PDF over REST: the bytes of `kennzahlenNode.download`, Base64 with SHA-256. */
describe("GET /reports/{form}/{period}/sheet.pdf (EXP-020, API-023)", () => {
  test("API-023 EXP-020 the PDF sheet returns the action's bytes as Base64 with their SHA-256; the form/period pair is checked first", async () => {
    const endpoint = accountingReportsResource.endpoints.find((e) => e.operationId === "getKennzahlenSheetPdf");
    if (!endpoint) throw new Error("missing endpoint");
    expect(endpoint.scope).toBe("reports:read");
    const pdf = new TextEncoder().encode("%PDF-1.7 test");
    const calls: { fn: unknown; args: unknown }[] = [];
    const convex = {
      action: async (fn: unknown, args: unknown) => {
        calls.push({ fn, args });
        return { name: "UStVA_2026-09_Kennzahlen.pdf", mime: "application/pdf", data: pdf.buffer };
      },
    } as never;
    const out = await endpoint.handler({ params: { form: "ustva", period: "2026-09" }, convex } as never);
    expect(calls).toEqual([
      { fn: api.kennzahlenNode.download, args: { form: "ustva", period: "2026-09", format: "pdf" } },
    ]);
    expect(out.body).toEqual({
      file_name: "UStVA_2026-09_Kennzahlen.pdf",
      content_type: "application/pdf",
      sha256: await sha256Hex(pdf),
      content_base64: Buffer.from(pdf).toString("base64"),
    });
    await expect(
      endpoint.handler({ params: { form: "ustva", period: "2026" }, convex } as never),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(calls).toHaveLength(1);
  });
});
