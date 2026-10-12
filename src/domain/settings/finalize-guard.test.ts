import { describe, expect, test } from "vitest";
import { httpStatusFor } from "../errors/http-status";
import { checkSetupComplete, SETUP_INCOMPLETE_MESSAGE } from "./finalize-guard";

describe("SET-005 finalisation is refused until the setup is complete (MAIL-03)", () => {
  test("SET-005 no profile or no setupCompletedAt → SETUP_INCOMPLETE with the German message", () => {
    for (const profile of [null, {}, { setupCompletedAt: undefined }]) {
      expect(checkSetupComplete(profile)).toEqual({ code: "setup_incomplete", message: SETUP_INCOMPLETE_MESSAGE });
    }
    expect(SETUP_INCOMPLETE_MESSAGE).toBe(
      "Die Einrichtung ist noch nicht abgeschlossen. Dokumente können erst danach fertiggestellt werden; Entwürfe sind möglich.",
    );
  });

  test("SET-005 a completed setup passes the guard", () => {
    expect(checkSetupComplete({ setupCompletedAt: Date.UTC(2026, 9, 12) })).toBeNull();
  });

  test("SET-005 T-SET-002 REST and MCP map setup_incomplete to HTTP 409 (05 §3)", () => {
    expect(httpStatusFor("setup_incomplete")).toBe(409);
    expect(httpStatusFor("version_conflict")).toBe(409);
  });
});

describe("error → HTTP status mapping (05 §3)", () => {
  test("SET-141 SET-142 auth, role, validation and unknown codes map to their problem+json status", () => {
    expect(httpStatusFor("unauthenticated")).toBe(401);
    expect(httpStatusFor("session_invalid")).toBe(401);
    expect(httpStatusFor("key_revoked")).toBe(401);
    expect(httpStatusFor("forbidden_role")).toBe(403);
    expect(httpStatusFor("forbidden_scope")).toBe(403);
    expect(httpStatusFor("owner_only")).toBe(403);
    expect(httpStatusFor("reauth_required")).toBe(403);
    expect(httpStatusFor("not_found")).toBe(404);
    expect(httpStatusFor("invalid_input")).toBe(422);
    expect(httpStatusFor("immutable_record")).toBe(409);
    expect(httpStatusFor("conflict")).toBe(409);
    expect(httpStatusFor("something_else")).toBe(500);
  });
});
