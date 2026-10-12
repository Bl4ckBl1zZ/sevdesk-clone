import { describe, expect, test } from "vitest";
import { errorCode } from "./lib/errors";
import { patchCompanyProfile } from "./model/companyProfile";
import { assertSetupComplete } from "./model/finalizeGuard";
import { makeT } from "./test.setup";

const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;

describe("SET-005 finalisation guard (02 §6 step 1)", () => {
  test("SET-005 T-SET-002 before the setup is complete every finalisation path gets setup_incomplete (HTTP 409)", async () => {
    const t = makeT();
    const err = await t.run((ctx) => assertSetupComplete(ctx)).catch((e: unknown) => e);
    expect(errorCode(err)).toBe("setup_incomplete");
    expect((err as { data?: Record<string, unknown> }).data).toMatchObject({
      reason: "SETUP_INCOMPLETE",
      httpStatus: 409,
      message:
        "Die Einrichtung ist noch nicht abgeschlossen. Dokumente können erst danach fertiggestellt werden; Entwürfe sind möglich.",
    });
    // A partial profile (wizard in progress) is still refused.
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(ctx, { name: "Muster GmbH" }, { action: "settings.company.update" }),
    );
    expect(await t.run((ctx) => assertSetupComplete(ctx)).catch(errorCode)).toBe("setup_incomplete");
  });

  test("SET-005 after „Einrichtung abschließen“ the guard passes", async () => {
    const t = makeT();
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(ctx, { setupCompletedAt: Date.now() }, { action: "settings.setup.complete" }),
    );
    expect(await t.run((ctx) => assertSetupComplete(ctx)).catch(errorCode)).toBeNull();
  });
});
