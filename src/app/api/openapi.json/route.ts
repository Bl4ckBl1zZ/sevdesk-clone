import { buildOpenApi } from "@/server/openapi";

export const dynamic = "force-static";

/** GET /api/openapi.json (05 §7): the OpenAPI 3.1 document of /api/v1 (`api.` host, port 443 only). */
export function GET() {
  return Response.json(buildOpenApi(), { headers: { "Cache-Control": "public, max-age=300" } });
}
