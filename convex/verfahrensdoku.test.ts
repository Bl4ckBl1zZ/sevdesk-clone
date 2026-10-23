import { describe, expect, test } from "vitest";
import { sha256Hex } from "../src/domain/audit/chain";
import { VD_CHAPTERS } from "../src/domain/docs/verfahrensdoku";
import { api, internal } from "./_generated/api";
import { INVOICE_RANGE, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { makeT } from "./test.setup";

/** F12 AUD-024/025, E-AUD-40/41/42: Verfahrensdokumentation chapters, release, versions and the watch list. */

const complete = () =>
  Object.fromEntries(VD_CHAPTERS.flatMap((c) => c.fields.filter((f) => f.required).map((f) => [f.key, "erledigt"])));
const messageOf = (e: unknown) => String((e as { data?: { message?: string } }).data?.message ?? e);

describe("Verfahrensdokumentation (AUD-024, AUD-025)", { timeout: 30_000 }, () => {
  test("AUD-024 E-AUD-40 release is refused with missing owner inputs; after completion an immutable version is stored", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const v0 = await owner.query(api.verfahrensdoku.view, {});
    expect(v0.doc.chapters).toHaveLength(17);
    expect(v0.releaseIssue).toMatch(/^Für die Freigabe fehlen Angaben in Kapitel 1:/);
    const refused = await owner.action(api.verfahrensdoku.release, {}).catch((e: unknown) => e);
    expect(errorCode(refused)).toBe("invalid_input");
    expect(messageOf(refused)).toContain("Kapitel 1");

    await owner.mutation(api.verfahrensdoku.saveInputs, { values: complete() });
    expect((await owner.query(api.verfahrensdoku.view, {})).releaseIssue).toBeNull();
    const r1 = await owner.action(api.verfahrensdoku.release, {});
    expect(r1.version).toBe(1);
    const row = await t.run((ctx) => ctx.db.query("verfahrensdokuVersions").first());
    const bytes = new Uint8Array(
      await t.run(async (ctx) => {
        const blob = row ? await ctx.storage.get(row.file.storageId) : null;
        return blob ? await blob.arrayBuffer() : new ArrayBuffer(0);
      }),
    );
    expect(row?.file.sha256).toBe(await sha256Hex(bytes));
    expect(new TextDecoder().decode(bytes)).toContain("Version 1, gültig ab");

    const r2 = await owner.action(api.verfahrensdoku.release, {});
    expect(r2.version).toBe(2);
    const view = await owner.query(api.verfahrensdoku.view, {});
    expect(view.versions.map((v) => [v.version, v.supersededAt !== null])).toEqual([
      [2, false],
      [1, true],
    ]);
    const v1 = await t.run((ctx) =>
      ctx.db
        .query("verfahrensdokuVersions")
        .withIndex("by_version", (q) => q.eq("version", 1))
        .first(),
    );
    expect(v1?.retentionUntil).toBe("2036-12-31");
    // E-AUD-42: the old version is delivered unchanged
    const old = await owner.query(api.verfahrensdoku.versionUrl, { version: 1 });
    expect(old.sha256).toBe(row?.file.sha256);

    const bookkeeper = await t.asUser("bookkeeper");
    expect(errorCode(await bookkeeper.action(api.verfahrensdoku.release, {}).catch((e: unknown) => e))).toBe(
      "forbidden_role",
    );
    expect(
      errorCode(await bookkeeper.mutation(api.verfahrensdoku.saveInputs, { values: {} }).catch((e: unknown) => e)),
    ).toBe("forbidden_role");
  });

  test("E-AUD-42 an old version is delivered unchanged (same file, same SHA-256) after later releases and changes", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.mutation(api.verfahrensdoku.saveInputs, { values: complete() });
    await owner.action(api.verfahrensdoku.release, {});
    const v1 = await t.run((ctx) =>
      ctx.db
        .query("verfahrensdokuVersions")
        .withIndex("by_version", (q) => q.eq("version", 1))
        .first(),
    );
    if (!v1) throw new Error("no version 1");
    const bytesOf = async (storageId: string) =>
      new Uint8Array(
        await t.run(async (ctx) => {
          const blob = await ctx.storage.get(storageId as never);
          return blob ? await blob.arrayBuffer() : new ArrayBuffer(0);
        }),
      );
    const before = await bytesOf(v1.file.storageId);

    // later: inputs change, number ranges change, a new version is released
    await owner.mutation(api.verfahrensdoku.saveInputs, { values: { ...complete(), deputy: "Neue Vertretung" } });
    await owner.mutation(api.settings.saveNumberRanges, {
      values: { ranges: [{ ...INVOICE_RANGE, format: "R-{YYYY}-{#####}" }] },
    });
    expect((await owner.action(api.verfahrensdoku.release, {})).version).toBe(2);

    const old = await owner.query(api.verfahrensdoku.versionUrl, { version: 1 });
    expect(old).toMatchObject({ name: v1.file.name, sha256: v1.file.sha256, url: expect.any(String) });
    const after = await bytesOf(v1.file.storageId);
    expect(after).toEqual(before);
    expect(await sha256Hex(after)).toBe(v1.file.sha256);
    expect(new TextDecoder().decode(after)).not.toContain("Neue Vertretung");
    expect(errorCode(await owner.query(api.verfahrensdoku.versionUrl, { version: 9 }).catch((e: unknown) => e))).toBe(
      "not_found",
    );
  });

  test("AUD-025 E-AUD-41 a changed number range marks the release outdated with a diff and a notification", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.mutation(api.verfahrensdoku.saveInputs, { values: complete() });
    await owner.action(api.verfahrensdoku.release, {});
    expect((await owner.query(api.verfahrensdoku.view, {})).outdated).toBeNull();
    expect(await t.mutation(internal.verfahrensdoku.watchCron, { force: true })).toBeNull();

    await owner.mutation(api.settings.saveNumberRanges, {
      values: { ranges: [{ ...INVOICE_RANGE, format: "R-{YYYY}-{#####}" }] },
    });
    const view = await owner.query(api.verfahrensdoku.view, {});
    expect(view.outdated?.message).toBe("Verfahrensdokumentation muss aktualisiert werden: Nummernkreise.");
    expect(view.outdated?.diff[0]?.key).toBe("numberRanges");
    expect(view.outdated?.diff[0]?.after).toContain("R-{YYYY}-{#####}");
    expect(await t.mutation(internal.verfahrensdoku.watchCron, {})).toBeNull(); // IS_TEST skip
    expect(await t.mutation(internal.verfahrensdoku.watchCron, { force: true })).toContain("Nummernkreise");
    const open = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(open.find((n) => n.kind === "verfahrensdoku.outdated" && n.resolvedAt === undefined)).toBeDefined();

    await owner.action(api.verfahrensdoku.release, {});
    const after = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(after.find((n) => n.kind === "verfahrensdoku.outdated")?.resolvedAt).toBeDefined();
    expect((await owner.query(api.verfahrensdoku.view, {})).outdated).toBeNull();
  });
});
