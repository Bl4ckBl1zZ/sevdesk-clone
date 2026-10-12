import { NextResponse } from "next/server";
import { publicHealthBody } from "@/domain/system/health";
import { cachedHealth } from "@/server/system/health";

export const dynamic = "force-dynamic";

/**
 * GET /api/health (02 §11, F01 SET-131): runs the web-side checks (Convex, einvoice-tools, clock skew; cached 60 s)
 * and answers with the minimal body `{ status: "ok" | "degraded", version }` — always HTTP 200 so the container
 * health check reflects the process, not its dependencies. Details are shown on /einstellungen/system.
 */
export async function GET() {
  const report = await cachedHealth();
  return NextResponse.json(publicHealthBody(report.checks, process.env.APP_VERSION ?? "dev"));
}
