import { handleApiRequest } from "@/server/api/dispatch";
import { ROUTES } from "@/server/api/resources";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/v1/** (05-api): one catch-all route; the endpoint registry in src/server/api/resources decides. proxy.ts
 * serves this path only on the `api.` host (443 for owner tools, 8443 for the website server, 02 §4.1).
 */
const handler = (request: Request) => handleApiRequest(request, ROUTES);

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
