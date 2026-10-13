import { ApiReference } from "@scalar/nextjs-api-reference";

/** GET /api/docs (05 §7): Scalar API reference for /api/openapi.json (`api.` host, port 443 only). */
export const GET = ApiReference({ url: "/api/openapi.json", pageTitle: "Rechnungen API" });
