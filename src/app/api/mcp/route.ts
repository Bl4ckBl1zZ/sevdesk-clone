import { handleMcpRequest } from "@/server/mcp/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** /api/mcp (06 §1): stateless MCP endpoint on the `api.` host, port 443 only (never 8443, proxy.ts). */
export const GET = handleMcpRequest;
export const POST = handleMcpRequest;
export const DELETE = handleMcpRequest;
