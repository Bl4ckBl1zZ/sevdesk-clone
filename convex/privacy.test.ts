import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { makeT } from "./test.setup";

/** F12 PRV-015/016, F01 SET-048/109/114, 01 DSGVO-01: external services, AVV confirmations, Art. 30, retention tab. */

async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

describe("datenschutz page (PRV-016, SET-114)", () => {
  test("SET-114 SET-048 the page lists services in use with region and AVV status; ntfy.sh is flagged; AVV can be confirmed", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.mutation(api.notifications.saveNtfy, {
      ntfy: { serverUrl: "https://ntfy.sh", topic: "firma", sendDetails: false },
    });
    const list = await owner.query(api.privacy.externalServices, { publicEdge: true });
    const ids = list.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining(["cloudflare_edge", "tailscale", "lets_encrypt", "ntfy", "evatr", "vies"]),
    );
    expect(list.find((s) => s.id === "ntfy")).toMatchObject({ effectiveRegion: "unknown", detail: "ntfy.sh" });
    expect(list.find((s) => s.id === "ntfy")?.warning).toContain("außerhalb der EU");
    expect(list.find((s) => s.id === "evatr")).toMatchObject({ role: "public_authority", warning: null });
    expect(list.find((s) => s.id === "tailscale")?.avvMissing).toBe(true);

    await owner.mutation(api.privacy.confirmAvv, { serviceId: "tailscale", confirmed: true, note: "DPA vom 01.10." });
    expect((await owner.query(api.privacy.externalServices, {})).find((s) => s.id === "tailscale")).toMatchObject({
      avvMissing: false,
      warning: null,
    });
    await owner.mutation(api.privacy.confirmAvv, { serviceId: "tailscale", confirmed: false });
    expect((await owner.query(api.privacy.externalServices, {})).find((s) => s.id === "tailscale")?.avvMissing).toBe(
      true,
    );
    expect(
      errorCode(await catching(owner.mutation(api.privacy.confirmAvv, { serviceId: "evatr", confirmed: true }))),
    ).toBe("invalid_input");
    const bookkeeper = await t.asUser("bookkeeper");
    expect(
      errorCode(
        await catching(bookkeeper.mutation(api.privacy.confirmAvv, { serviceId: "tailscale", confirmed: true })),
      ),
    ).toBe("forbidden_role");
  });

  test("SET-048 saving a non-EU or unknown-region ntfy server warns but saves; a tailnet server does not warn", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const publicServer = await owner.mutation(api.notifications.saveNtfy, {
      ntfy: { serverUrl: "https://ntfy.sh", topic: "firma", sendDetails: false },
    });
    expect(publicServer.warning).toContain("ntfy (ntfy.sh) verarbeitet Daten außerhalb der EU");
    const tailnet = await owner.mutation(api.notifications.saveNtfy, {
      ntfy: { serverUrl: "https://ntfy.tail1234.ts.net", topic: "firma", sendDetails: false },
    });
    expect(tailnet.warning).toBeNull();
    expect((await owner.mutation(api.notifications.saveNtfy, { ntfy: null })).warning).toBeNull();
  });

  test("DSGVO-01 PRV-015 PRV-001 the Art. 30 record uses the company and the services; the retention tab shows the classes", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { record, markdown } = await owner.query(api.privacy.art30, {});
    expect(record.controller.name.length).toBeGreaterThan(0);
    expect(markdown).toContain(`## Verantwortlicher\n\n${record.controller.name}`);
    expect(record.activities.find((a) => a.name.startsWith("Benutzerkonten"))?.recipients).toContain("Tailscale");
    const r = await owner.query(api.privacy.retention, {});
    expect(r.version).toBe("retention-2026.1");
    expect(r.classes.map((c) => [c.cls, c.years])).toEqual([
      ["books10", 10],
      ["vouchers8", 8],
      ["letters6", 6],
      ["none", null],
    ]);
    expect(r.classes[1]?.tables).toContain("salesDocuments");
  });
});
