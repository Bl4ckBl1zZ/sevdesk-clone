import { describe, expect, test } from "vitest";
import { z } from "zod";
import { confirmTokenArg, defineTool, REQUIRES_USER_INTERACTION, toolError, toolVisible } from "./tool";

const handler = async () => ({});

describe("MCP tool registration (06 §2, CLAUDE.md rule 8)", () => {
  test("MCP-005 a ⚠ tool without confirmIntent or without a required confirm_token is refused at registration", () => {
    expect(() =>
      defineTool({
        name: "x_act",
        title: "x",
        description: "x",
        kind: "danger",
        scopes: ["contacts:write"],
        input: z.object({}),
        handler,
      }),
    ).toThrow(/confirmIntent/);
    expect(() =>
      defineTool({
        name: "contact_merge",
        title: "x",
        description: "x",
        kind: "danger",
        confirmIntent: "contact_merge",
        scopes: ["contacts:write"],
        input: z.object({ id: z.string() }),
        handler,
      }),
    ).toThrow(/confirm_token/);
    expect(() =>
      defineTool({
        name: "contact_merge",
        title: "x",
        description: "x",
        kind: "danger",
        confirmIntent: "contact_merge",
        scopes: ["contacts:write"],
        input: z.object({ confirm_token: confirmTokenArg.optional() }),
        handler,
      }),
    ).toThrow(/required/);
    expect(() =>
      defineTool({
        name: "contact_get",
        title: "x",
        description: "x",
        kind: "read",
        confirmIntent: "contact_merge",
        scopes: ["contacts:read"],
        input: z.object({}),
        handler,
      }),
    ).toThrow(/only ⚠ tools/);
  });

  test("MCP-002 MCP-005 annotations are derived from the kind; ⚠ and approval tools carry requiresUserInteraction", () => {
    const danger = defineTool({
      name: "contact_merge",
      title: "x",
      description: "x",
      kind: "danger",
      confirmIntent: "contact_merge",
      scopes: ["contacts:write"],
      input: z.object({ confirm_token: confirmTokenArg }),
      handler,
    });
    expect(danger.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(danger.meta).toEqual({ [REQUIRES_USER_INTERACTION]: true });
    const consent = defineTool({
      name: "contact_set_pdf_consent",
      title: "x",
      description: "x",
      kind: "write",
      requiresUserInteraction: true,
      scopes: ["contacts:write"],
      input: z.object({}),
      handler,
    });
    expect(consent.annotations.destructiveHint).toBe(false);
    expect(consent.meta).toEqual({ [REQUIRES_USER_INTERACTION]: true });
    const read = defineTool({
      name: "contact_get",
      title: "x",
      description: "x",
      kind: "read",
      scopes: ["contacts:read"],
      input: z.object({}),
      handler,
    });
    expect(read.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(read.meta).toEqual({});
  });

  test("MCP-003 a tool is visible when the key holds one of its scopes", () => {
    const t = defineTool({
      name: "contact_get",
      title: "x",
      description: "x",
      kind: "read",
      scopes: ["contacts:read"],
      input: z.object({}),
      handler,
    });
    expect(toolVisible(t, ["contacts:read"])).toBe(true);
    expect(toolVisible(t, ["products:read"])).toBe(false);
  });

  test("MCP-010 Convex errors become isError results with code, message and a German hint", () => {
    const r = toolError({ data: { code: "confirm_token_expired", message: "abgelaufen" } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]?.text ?? "{}").error).toMatchObject({
      code: "confirm_token_expired",
      hint: expect.any(String),
    });
    const v = toolError({ data: { code: "invalid_input", reason: "UPSERT_AMBIGUOUS", message: "mehrere" } });
    expect(JSON.parse(v.content[0]?.text ?? "{}").error).toMatchObject({
      code: "upsert_ambiguous",
      hint: expect.any(String),
    });
  });
});
