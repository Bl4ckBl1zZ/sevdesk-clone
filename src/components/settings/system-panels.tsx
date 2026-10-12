"use client";

import { api } from "@convex/_generated/api";
import { useAction, useMutation } from "convex/react";
import { ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import type { StatusCheck } from "@/components/setup/actions";
import { StatusCheckList } from "@/components/setup/status-check";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { EinvoiceToolsVersions, HealthCheck } from "@/domain/system/health";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";

export interface VersionsView {
  app: { version: string; gitSha: string | null; buildDate: string | null };
  next: string;
  node: string;
  convexImage: string | null;
  betterAuth: string;
  ruleTables: string;
}

/** SET-130: versions of the app and its components. */
export function VersionsCard({
  versions,
  einvoice,
}: {
  versions: VersionsView;
  einvoice: EinvoiceToolsVersions | null;
}) {
  const t = useTranslations("settings.system");
  const rows: [string, string][] = [
    [t("appVersion"), versions.app.version],
    [t("gitSha"), versions.app.gitSha ?? "—"],
    [t("buildDate"), versions.app.buildDate ?? "—"],
    ["Next.js", versions.next],
    ["Node.js", versions.node],
    [t("convexImage"), versions.convexImage ?? "—"],
    ["better-auth", versions.betterAuth],
    [t("kosit"), einvoice?.kosit ?? "—"],
    [t("xrechnungConfig"), einvoice?.xrechnungConfig ?? "—"],
    ["Mustang", einvoice?.mustang ?? "—"],
    [t("ruleTables"), versions.ruleTables],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("versionsTitle")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-2 text-sm @2xl/main:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3 border-b py-1.5">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-all text-right font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/** SET-131: web-side checks (server-rendered) plus the owner's on-demand Cloudflare/R2 checks (Convex actions). */
export function HealthPanel({ checks, isOwner }: { checks: HealthCheck[]; isOwner: boolean }) {
  const t = useTranslations("settings.system");
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("healthTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("healthDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <StatusCheckList checks={checks} label={t("healthTitle")} />
        {isOwner && (
          <ConvexGuard fallback={null}>
            <ServiceChecks />
          </ConvexGuard>
        )}
      </CardContent>
    </Card>
  );
}

function ServiceChecks() {
  const t = useTranslations("settings.system");
  const verifyToken = useAction(api.system.verifyEmailToken);
  const storage = useAction(api.settings.testCheckpointStorage);
  const showError = useAdapterErrorToast();
  const [results, setResults] = useState<StatusCheck[] | null>(null);
  const [pending, setPending] = useState(false);
  const run = async () => {
    setPending(true);
    try {
      const [email, r2] = await Promise.all([verifyToken({}), storage({})]);
      setResults([email, ...r2]);
    } catch (e) {
      showError(e);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      {results && <StatusCheckList checks={results} label={t("servicesTitle")} />}
      <Button variant="outline" className="h-11 self-start md:h-9" disabled={pending} onClick={() => void run()}>
        {t("runServiceChecks")}
      </Button>
    </>
  );
}

/** SET-135: server location, access concept, restore-drill reminder and record. */
export function SystemOverviewPanel({ isOwner }: { isOwner: boolean }) {
  return (
    <ConvexGuard fallback={<div className="h-40" aria-busy="true" />}>
      <SystemOverviewInner isOwner={isOwner} />
    </ConvexGuard>
  );
}

function SystemOverviewInner({ isOwner }: { isOwner: boolean }) {
  const t = useTranslations("settings.system");
  const overview = useAuthedQuery(api.system.overview, {});
  const [recording, setRecording] = useState(false);
  if (overview === undefined) return <div className="h-40" aria-busy="true" />;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle>
            <h2>{t("operationsTitle")}</h2>
          </CardTitle>
          <CardDescription>{t("operationsDescription")}</CardDescription>
        </div>
        {isOwner && (
          <Link
            href="/einstellungen/system/sicherheit"
            className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}
          >
            <ShieldCheckIcon aria-hidden="true" />
            {t("securityLink")}
          </Link>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <dl className="grid gap-2 @2xl/main:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t("serverLocation")}</dt>
            <dd>{overview.serverLocation ? overview.serverLocation.countryCode : t("notRecorded")}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("accessConcept")}</dt>
            <dd>
              {overview.accessConcept
                ? t("accessConceptValue", { domain: overview.accessConcept.baseDomain })
                : t("notRecorded")}
            </dd>
          </div>
        </dl>
        <p
          role={overview.restoreDrill.due ? "alert" : undefined}
          className={
            overview.restoreDrill.due
              ? "rounded-md border border-warning/40 bg-warning/10 p-3"
              : "rounded-md border bg-muted/30 p-3"
          }
        >
          {overview.restoreDrill.message}
        </p>
        {overview.drills.length > 0 && (
          <ul className="flex flex-col divide-y rounded-lg border" aria-label={t("drillsTitle")}>
            {overview.drills.map((d) => (
              <li key={`${d.date}-${d.backupObject}`} className="flex flex-wrap items-center gap-2 p-3">
                <span className="font-medium">{d.date}</span>
                <span className="break-all text-muted-foreground">{d.backupObject}</span>
                <Badge variant={d.integrityOk && d.headMatchesCheckpoint ? "secondary" : "destructive"}>
                  {d.integrityOk && d.headMatchesCheckpoint ? t("drillOk") : t("drillFailed")}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {isOwner && (
          <Button variant="outline" className="h-11 self-start md:h-9" onClick={() => setRecording(true)}>
            {t("recordDrill")}
          </Button>
        )}
      </CardContent>
      {recording && <RestoreDrillDialog onClose={() => setRecording(false)} />}
    </Card>
  );
}

function RestoreDrillDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("settings.system");
  const tCommon = useTranslations("common");
  const record = useMutation(api.system.recordRestoreDrill);
  const showError = useAdapterErrorToast();
  const id = useId();
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());
  const [date, setDate] = useState(today);
  const [backupObject, setBackupObject] = useState("");
  const [targetEnvironment, setTargetEnvironment] = useState("");
  const [integrityOk, setIntegrityOk] = useState(true);
  const [headMatchesCheckpoint, setHeadMatchesCheckpoint] = useState(true);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await record({
        date,
        backupObject,
        targetEnvironment,
        integrityOk,
        headMatchesCheckpoint,
        ...(notes ? { notes } : {}),
      });
      toast.success(t("drillRecorded"));
      onClose();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("recordDrill")}</DialogTitle>
          <DialogDescription>{t("recordDrillDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-date`}>{t("drillDate")}</Label>
            <Input
              id={`${id}-date`}
              type="date"
              className="h-11 md:h-9"
              value={date}
              max={today}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-backup`}>{t("drillBackup")}</Label>
            <Input
              id={`${id}-backup`}
              className="h-11 md:h-9"
              value={backupObject}
              onChange={(e) => setBackupObject(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-target`}>{t("drillTarget")}</Label>
            <Input
              id={`${id}-target`}
              className="h-11 md:h-9"
              value={targetEnvironment}
              onChange={(e) => setTargetEnvironment(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3">
            <input
              id={`${id}-integrity`}
              type="checkbox"
              className="size-5 accent-primary md:size-4"
              checked={integrityOk}
              onChange={(e) => setIntegrityOk(e.target.checked)}
            />
            <label htmlFor={`${id}-integrity`} className="text-sm">
              {t("drillIntegrity")}
            </label>
          </div>
          <div className="flex items-center gap-3">
            <input
              id={`${id}-head`}
              type="checkbox"
              className="size-5 accent-primary md:size-4"
              checked={headMatchesCheckpoint}
              onChange={(e) => setHeadMatchesCheckpoint(e.target.checked)}
            />
            <label htmlFor={`${id}-head`} className="text-sm">
              {t("drillCheckpoint")}
            </label>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-notes`}>{t("drillNotes")}</Label>
            <Textarea id={`${id}-notes`} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button
            className="h-11 md:h-9"
            disabled={busy || !backupObject.trim() || !targetEnvironment.trim()}
            onClick={() => void submit()}
          >
            {tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** AUD-020: evaluated setup checks (server) and the live probes (Convex actions, deployed stack). */
export function SecurityPanel({ checks }: { checks: StatusCheck[] }) {
  const t = useTranslations("settings.security");
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("checksTitle")}</h2>
          </CardTitle>
          <CardDescription>{t("checksDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <StatusCheckList checks={checks} label={t("checksTitle")} />
        </CardContent>
      </Card>
      <ConvexGuard fallback={null}>
        <LiveProbes />
      </ConvexGuard>
    </div>
  );
}

function LiveProbes() {
  const t = useTranslations("settings.security");
  const access = useAction(api.settings.runAccessChecks);
  const storage = useAction(api.settings.testCheckpointStorage);
  const showError = useAdapterErrorToast();
  const [results, setResults] = useState<StatusCheck[] | null>(null);
  const [pending, setPending] = useState(false);
  const run = async () => {
    setPending(true);
    try {
      const [a, s] = await Promise.all([access({}), storage({})]);
      setResults([...a, ...s]);
    } catch (e) {
      showError(e);
    } finally {
      setPending(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("probesTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("probesDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {results && <StatusCheckList checks={results} label={t("probesTitle")} />}
        <Button variant="outline" className="h-11 self-start md:h-9" disabled={pending} onClick={() => void run()}>
          {t("runProbes")}
        </Button>
      </CardContent>
    </Card>
  );
}

/** SET-106: read-only auth e-mail card (configuration from the Convex env; the token value is never shown). */
export function AuthMailCard() {
  return (
    <ConvexGuard fallback={null}>
      <AuthMailCardInner />
    </ConvexGuard>
  );
}

function AuthMailCardInner() {
  const t = useTranslations("settings.authMail");
  const status = useAuthedQuery(api.system.authMailStatus, {});
  if (status === undefined) return <div className="h-24" aria-busy="true" />;
  const last =
    status.lastTestAt === null
      ? t("never")
      : `${new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" }).format(status.lastTestAt)} · ${status.lastTestOk ? t("ok") : t("failed")}${status.lastTestDetail ? ` (${status.lastTestDetail})` : ""}`;
  return (
    <dl className="grid gap-2 text-sm" aria-label={t("title")}>
      <div className="flex flex-wrap justify-between gap-2">
        <dt className="text-muted-foreground">{t("from")}</dt>
        <dd className="break-all">{status.from ?? t("missing")}</dd>
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        <dt className="text-muted-foreground">{t("accountId")}</dt>
        <dd className="break-all font-mono">{status.accountId ?? t("missing")}</dd>
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        <dt className="text-muted-foreground">{t("token")}</dt>
        <dd>{status.tokenConfigured ? t("configured") : t("missing")}</dd>
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        <dt className="text-muted-foreground">{t("lastDelivery")}</dt>
        <dd>{last}</dd>
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        <dt className="text-muted-foreground">{t("purposes")}</dt>
        <dd>{status.purposes.map((p) => t(`purpose.${p}`)).join(", ")}</dd>
      </div>
    </dl>
  );
}
