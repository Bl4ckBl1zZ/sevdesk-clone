import type * as React from "react";
import type { Permission } from "@/domain/access/permissions";
import { AccessError, requireRole } from "@/lib/auth-server";

/**
 * Server-side role check for a page (CLAUDE.md rule 7, 02 §4.3): signed out → /anmelden; a role without
 * `permission` (or an expired member) sees the German reason instead of the content. The Convex functions check
 * again — this only avoids rendering pages that would fail.
 */
export async function RoleGate({ permission, children }: { permission: Permission; children: React.ReactNode }) {
  try {
    await requireRole(permission);
  } catch (e) {
    if (e instanceof AccessError) {
      return (
        <p role="alert" className="mx-auto mt-10 max-w-xl rounded-md border border-warning bg-warning/10 p-4 text-sm">
          {e.message}
        </p>
      );
    }
    throw e;
  }
  return <>{children}</>;
}
