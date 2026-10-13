import { describe, expect, test } from "vitest";
import { RESOURCES } from "./api/resources";
import { buildOpenApi } from "./openapi";

describe("OpenAPI 3.1 document (05 §7)", () => {
  test("API-014 the document matches the committed snapshot (pnpm openapi:check; update with -u and review)", async () => {
    const doc = buildOpenApi(RESOURCES, "snapshot");
    await expect(`${JSON.stringify(doc, null, 2)}\n`).toMatchFileSnapshot("./openapi.snapshot.json");
  });

  test("API-014 every registered endpoint is documented with operationId, scope text and problem responses", () => {
    const doc = buildOpenApi(RESOURCES, "x") as unknown as {
      openapi: string;
      paths: Record<
        string,
        Record<string, { operationId: string; description: string; responses: Record<string, unknown> }>
      >;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
    expect(ops).toHaveLength(RESOURCES.flatMap((r) => r.endpoints).length);
    for (const op of ops) {
      expect(op.operationId).toBeTruthy();
      expect(op.description).toMatch(/Scope|Schlüssel/);
    }
    expect(doc.paths["/api/v1/contacts"]?.get?.responses["401"]).toBeDefined();
    expect(doc.paths["/api/v1/health"]?.get?.responses["401"]).toBeUndefined();
    expect(Object.keys(doc.components.schemas)).toEqual(expect.arrayContaining(["Contact", "Product", "Problem"]));
  });
});
