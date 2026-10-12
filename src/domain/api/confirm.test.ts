import { describe, expect, test } from "vitest";
import {
  CONFIRM_INTENTS,
  CONFIRM_TOKEN_MESSAGES,
  checkConfirmToken,
  confirmParamsHash,
  documentPreviewIntent,
  type StoredConfirmToken,
} from "./confirm";

const stored: StoredConfirmToken = {
  keyId: "key_abc",
  intent: "contact_merge",
  paramsHash: "h1",
  entities: [{ table: "contacts", id: "c1", version: 3 }],
  expiresAt: 10_000,
};
const call = {
  keyId: "key_abc",
  intent: "contact_merge",
  paramsHash: "h1",
  now: 5_000,
  current: new Map<string, number | null | undefined>([["contacts:c1", 3]]),
};

describe("confirm tokens (06 §2.3)", () => {
  test("MCP-004 a fresh token for the same key, intent, params and versions is accepted", () => {
    expect(checkConfirmToken(stored, call)).toBeNull();
  });

  test("MCP-004 unknown token or another key's token is invalid", () => {
    expect(checkConfirmToken(null, call)).toBe("confirm_token_invalid");
    expect(checkConfirmToken(stored, { ...call, keyId: "key_other" })).toBe("confirm_token_invalid");
  });

  test("MCP-004 a token is single use", () => {
    expect(checkConfirmToken({ ...stored, usedAt: 1 }, call)).toBe("confirm_token_used");
  });

  test("MCP-004 a token expires after 10 minutes", () => {
    expect(checkConfirmToken(stored, { ...call, now: 10_000 })).toBe("confirm_token_expired");
  });

  test("MCP-004 a token for another intent is refused with confirm_token_intent_mismatch", () => {
    expect(checkConfirmToken(stored, { ...call, intent: "document_finalize" })).toBe("confirm_token_intent_mismatch");
  });

  test("MCP-004 EC-003 changed params or a changed entity version → preview_outdated", () => {
    expect(checkConfirmToken(stored, { ...call, paramsHash: "h2" })).toBe("preview_outdated");
    expect(checkConfirmToken(stored, { ...call, current: new Map([["contacts:c1", 4]]) })).toBe("preview_outdated");
    expect(checkConfirmToken(stored, { ...call, current: new Map() })).toBe("preview_outdated");
  });

  test("MCP-004 the params hash is canonical (key order) and ignores confirmToken", async () => {
    const a = await confirmParamsHash({ b: 1, a: { y: 2, x: [1, 2] }, confirmToken: "ct_1" });
    const b = await confirmParamsHash({ a: { x: [1, 2], y: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(await confirmParamsHash({ a: { x: [2, 1], y: 2 }, b: 1 })).not.toBe(a);
  });

  test("MCP-004 document_preview intents map to document_finalize / invoice_cancel", () => {
    expect(documentPreviewIntent("finalize")).toBe("document_finalize");
    expect(documentPreviewIntent("cancel")).toBe("invoice_cancel");
    expect(CONFIRM_INTENTS.dunning_run).toBe("dunning_preview");
    expect(CONFIRM_INTENTS.contact_merge).toBe("preview_action");
  });

  test("MCP-004 every error has a German message", () => {
    for (const m of Object.values(CONFIRM_TOKEN_MESSAGES)) expect(m.length).toBeGreaterThan(10);
  });
});
