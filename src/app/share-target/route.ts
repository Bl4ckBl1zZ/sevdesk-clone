import { api } from "@convex/_generated/api";
import { AccessError, fetchAuthAction, isAuthenticated, requireRole } from "@/lib/auth-server";
import { handleShareTarget } from "@/server/share-target";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /share-target — PWA share target (F06 INB-004); plumbing only, see src/server/share-target.ts. */
export async function POST(request: Request): Promise<Response> {
  if (!(await isAuthenticated())) {
    return new Response(null, { status: 303, headers: { Location: "/anmelden?weiter=%2Fposteingang" } });
  }
  return handleShareTarget(request, {
    requireWriter: async () => {
      try {
        await requireRole("vouchers.write");
      } catch (e) {
        if (e instanceof AccessError) throw Object.assign(new Error(e.message), { status: 403 });
        throw e;
      }
    },
    ingest: async (file) => {
      const r = await fetchAuthAction(api.inbox.ingestBase64, { files: [file], via: "app" });
      return { id: r.id };
    },
  });
}

/** Opening the URL directly (no share) leads to the Posteingang. */
export function GET(): Response {
  return new Response(null, { status: 303, headers: { Location: "/posteingang" } });
}
