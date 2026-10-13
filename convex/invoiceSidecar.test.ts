import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { createValues, orgForm } from "./catalog.fixtures";
import { finalizedInvoice, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { makeT } from "./test.setup";

/**
 * INV-20 / ER-12 against the real einvoice-tools sidecar (KoSIT 1.6.3 + XRechnung 3.0.2, Mustang 2.26 + veraPDF):
 * the preview XML is validated before the commit, the final XML and the hybrid PDF after it, and the reports are
 * archived next to the artifacts. Skipped unless EINVOICE_TOOLS_URL is set, e.g.
 * `EINVOICE_TOOLS_URL=http://127.0.0.1:8080 pnpm test -p convex convex/invoiceSidecar.test.ts`.
 */
const url = process.env.EINVOICE_TOOLS_URL;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe.skipIf(!url)("INV-20 ER-12 sidecar validation (KoSIT + Mustang)", () => {
  test("INV-20 ER-11 a ZUGFeRD invoice passes KoSIT before the commit and Mustang/veraPDF after it", {
    timeout: 120_000,
  }, async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.doc.einvoice.validation).toBe("passed");
    expect(detail?.doc.artifactStatus).toBe("ready");
    expect(detail?.artifacts.map((a) => a.kind).sort()).toEqual([
      "validation_report_kosit",
      "validation_report_mustang",
      "xrechnung_xml",
      "zugferd_pdf",
    ]);
  });

  test("INV-20 an XRechnung (B2G, Leitweg-ID) passes KoSIT; the report is archived", { timeout: 120_000 }, async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const authority = await owner.mutation(api.contacts.create, {
      values: createValues(
        orgForm("Stadtverwaltung Musterstadt", {
          isPublicAuthority: true,
          buyerReference: "04011000-1234512345-06",
          electronicAddressScheme: "0204",
          electronicAddressValue: "04011000-1234512345-06",
        }),
        { address: { street: "Rathausplatz 1", postalCode: "28195", city: "Bremen", countryCode: "DE" } },
      ),
    });
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(authority.id) });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.doc.einvoice.validation).toBe("passed");
    expect(detail?.doc.artifactStatus).toBe("ready");
    expect(detail?.artifacts.map((a) => a.kind)).toContain("validation_report_kosit");
  });
});
