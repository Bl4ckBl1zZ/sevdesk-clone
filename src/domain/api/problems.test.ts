import { describe, expect, test } from "vitest";
import { decodeDocumentId, decodeId, encodeDocumentId, encodeId, encodeOptionalId } from "./ids";
import { defaultFieldMapper, mapAppError, PROBLEMS, preferredLang, problem } from "./problems";

describe("problem+json (05 §3.1, RFC 9457)", () => {
  test("API-009 a problem has type, German title, status, code and request_id", () => {
    const p = problem("unauthorized", { requestId: "req_1", typeBase: "https://api.example.de" });
    expect(p).toEqual({
      type: "https://api.example.de/problems/unauthorized",
      title: PROBLEMS.unauthorized.de,
      status: 401,
      code: "unauthorized",
      request_id: "req_1",
    });
  });

  test("API-009 English titles with Accept-Language: en", () => {
    expect(preferredLang("en-US,en;q=0.9")).toBe("en");
    expect(preferredLang("de-DE,en;q=0.5")).toBe("de");
    expect(preferredLang("fr;q=0.2,en;q=0.8")).toBe("en");
    expect(preferredLang(null)).toBe("de");
    expect(problem("not_found", { requestId: "r", typeBase: "https://x", lang: "en" }).title).toBe("Not found.");
  });

  test("API-009 every problem code has a 4xx/5xx status and both titles", () => {
    for (const [code, def] of Object.entries(PROBLEMS)) {
      expect(def.status, code).toBeGreaterThanOrEqual(400);
      expect(def.de.length, code).toBeGreaterThan(3);
      expect(def.en.length, code).toBeGreaterThan(3);
    }
  });

  test("API-009 zod issues become errors[] with snake_case fields; the first carries the domain reason", () => {
    const m = mapAppError({
      code: "invalid_input",
      message: "USt-IdNr ungültig.",
      reason: "VAT_ID_FORMAT",
      issues: [
        { path: "contact.vatId", message: "USt-IdNr ungültig." },
        { path: "channels.0.value", message: "E-Mail ungültig." },
      ],
    });
    expect(m.code).toBe("validation_failed");
    expect(m.errors).toEqual([
      { code: "vat_id_format", field: "contact.vat_id", message: "USt-IdNr ungültig." },
      { code: "invalid", field: "channels[0].value", message: "E-Mail ungültig." },
    ]);
  });

  test("API-009 a custom field mapper strips form prefixes", () => {
    const m = mapAppError(
      { code: "invalid_input", message: "x", issues: [{ path: "contact.organizationName", message: "x" }] },
      { fieldMapper: (p) => defaultFieldMapper(p.replace(/^contact\./, "")) },
    );
    expect(m.errors[0]?.field).toBe("organization_name");
  });

  test("API-009 model errors with a single field keep the field", () => {
    const m = mapAppError({
      code: "invalid_input",
      message: "Nummer vergeben.",
      reason: "NUMBER_TAKEN",
      field: "number",
    });
    expect(m.errors).toEqual([{ code: "number_taken", field: "number", message: "Nummer vergeben." }]);
  });

  test("API-015 state conflicts reported as invalid_input reasons become 409 problems", () => {
    expect(mapAppError({ code: "invalid_input", reason: "UPSERT_AMBIGUOUS", message: "x" }).code).toBe(
      "upsert_ambiguous",
    );
    expect(mapAppError({ code: "invalid_input", reason: "CONTACT_IN_USE", message: "x" }).code).toBe("contact_in_use");
    expect(PROBLEMS.upsert_ambiguous.status).toBe(409);
  });

  test("API-005 forbidden_scope maps to 403 insufficient_scope with required_scope", () => {
    const m = mapAppError(
      { code: "forbidden_scope", message: "x", permission: "contacts.write" },
      { scopeForPermission: (p) => (p === "contacts.write" ? "contacts:write" : null) },
    );
    expect(m).toMatchObject({ code: "insufficient_scope", extra: { required_scope: "contacts:write" } });
  });

  test("API-003 revoked keys, unknown issuers and missing members all answer 401", () => {
    for (const code of ["key_revoked", "unauthenticated", "session_invalid"]) {
      expect(mapAppError({ code }).code).toBe("unauthorized");
    }
    expect(mapAppError({ code: "version_conflict" }).code).toBe("version_conflict");
    expect(mapAppError({ code: "something_new" }).code).toBe("bad_request");
  });
});

describe("F04 sales-document errors (05 §4.3, F04 §5.1)", () => {
  test("DOC-02 DOC-24 lifecycle, finalisation and chain guards map to their problems with the §5.1 code", () => {
    expect(mapAppError({ code: "illegal_transition", message: "x" }).code).toBe("illegal_transition");
    expect(PROBLEMS.illegal_transition.status).toBe(409);
    expect(mapAppError({ code: "document_not_draft" }).code).toBe("immutable_record");
    expect(mapAppError({ code: "number_conflict" }).code).toBe("number_conflict");
    expect(mapAppError({ code: "dependency_unavailable" }).code).toBe("dependency_unavailable");
    const guard = mapAppError({ code: "conflict", reason: "withdraw_has_invoices", message: "AB-1 hat Rechnungen." });
    expect(guard).toMatchObject({
      code: "conflict",
      errors: [{ code: "withdraw_has_invoices", message: "AB-1 hat Rechnungen." }],
    });
    const findings = [{ code: "supply_date_missing", rule: "UST-08", field: "supplyDate", message: "fehlt" }];
    const invalid = mapAppError({ code: "validation_failed", message: "fehlt", findings });
    expect(invalid).toMatchObject({
      code: "validation_failed",
      errors: [{ code: "supply_date_missing", rule: "UST-08", field: "supply_date", message: "fehlt" }],
    });
    expect(PROBLEMS.idempotency_key_required.status).toBe(400);
  });
});

describe("prefixed IDs (05 §3)", () => {
  const raw = "k57f3abcdefghijk0123456789";

  test("API-011 F04 §4.1 sales documents carry the prefix of their type", () => {
    expect(encodeDocumentId("quote", raw)).toBe(`quo_${raw}`);
    expect(encodeDocumentId("proforma", raw)).toBe(`inv_${raw}`);
    expect(encodeDocumentId("delivery_note", raw)).toBe(`dln_${raw}`);
    expect(decodeDocumentId("order_confirmation", `ord_${raw}`)).toBe(raw);
    expect(decodeDocumentId("order_confirmation", `quo_${raw}`)).toBeNull();
  });

  test("API-011 IDs are prefixed per table and round-trip", () => {
    expect(encodeId("contacts", raw)).toBe(`con_${raw}`);
    expect(decodeId("contacts", `con_${raw}`)).toBe(raw);
    expect(encodeOptionalId("products", undefined)).toBeNull();
  });

  test("API-011 a wrong prefix or shape decodes to null (treated as not found)", () => {
    expect(decodeId("contacts", `prd_${raw}`)).toBeNull();
    expect(decodeId("contacts", "con_")).toBeNull();
    expect(decodeId("contacts", "con_../../x")).toBeNull();
    expect(decodeId("productCategories", `pcat_${raw}`)).toBe(raw);
  });
});
