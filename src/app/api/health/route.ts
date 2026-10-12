import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — P0 placeholder (02 §11). Later: checks Convex, the einvoice-tools sidecar and
 * Cloudflare Email reachability (cached 60 s). Body stays minimal: `{ status, version }`.
 */
export function GET() {
  return NextResponse.json({ status: "ok", version: process.env.APP_VERSION ?? "dev" });
}
