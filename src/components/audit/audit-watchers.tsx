"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/**
 * Shell-wide audit helpers:
 * - DOC-41 / 04 §1.4: „Aktualisiert durch Claude (MCP)" toast when an API or MCP key changes data while the app is open.
 * - AUD-009: every page an auditor opens is logged (the server ignores calls of other roles).
 */
export function AuditWatchers() {
  return (
    <ConvexGuard>
      <ActorToast />
      <AuditorAccessLog />
    </ConvexGuard>
  );
}

function ActorToast() {
  const latest = useAuthedQuery(api.auditLog.latestExternalChange, {});
  const seen = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (latest === undefined) return;
    const seq = latest?.seq ?? null;
    if (seen.current !== undefined && seq !== null && seq !== seen.current) {
      toast.info(latest?.text ?? "", latest?.description ? { description: latest.description } : undefined);
    }
    seen.current = seq;
  }, [latest]);
  return null;
}

function AuditorAccessLog() {
  const me = useAuthedQuery(api.members.me, {});
  const pathname = usePathname();
  const record = useMutation(api.auditLog.recordAccess);
  useEffect(() => {
    if (me?.role === "auditor" && pathname) void record({ path: pathname }).catch(() => undefined);
  }, [me?.role, pathname, record]);
  return null;
}

/** AUD-009: mounted on the settings secrets screens (API keys, MCP, integrations); logs the visit once per mount. */
export function SecretScreenLog({ screen }: { screen: string }) {
  return (
    <ConvexGuard>
      <SecretScreenInner screen={screen} />
    </ConvexGuard>
  );
}

function SecretScreenInner({ screen }: { screen: string }) {
  const me = useAuthedQuery(api.members.me, {});
  const pathname = usePathname();
  const record = useMutation(api.auditLog.recordAccess);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !pathname || !me) return;
    done.current = true;
    void record({ path: pathname, secretScreen: screen }).catch(() => undefined);
  }, [me, pathname, record, screen]);
  return null;
}
