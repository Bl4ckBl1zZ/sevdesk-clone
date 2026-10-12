"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { CheckIcon, MailIcon, MinusIcon, UserPlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Controller, type UseFormReturn, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { FormErrorSummary, SelectField, TextField } from "@/components/forms/fields";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  INVITE_ROLES,
  type InviteValues,
  inviteArgsFromForm,
  inviteDefaults,
  inviteSchema,
  selectableFiscalYears,
} from "@/domain/schemas/members";
import { berlinCalendarDate } from "@/domain/time/berlin";
import { addDays } from "@/domain/time/calendar-date";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { formatTimestamp } from "@/i18n/format";

type Member = FunctionReturnType<typeof api.members.list>[number];
type Invite = FunctionReturnType<typeof api.invites.list>[number];
type InviteForm = UseFormReturn<InviteValues, unknown, InviteValues>;

const loading = <div className="h-96" aria-busy="true" />;

/**
 * `/einstellungen/mitglieder` (04-ui-ux §4.10, 02 §4.3): members with role, passkey/TOTP state, expiry and last
 * sign-in; „Person einladen“ (auditor scope per F12 AUD-022); open invites with „Erneut senden“/„Zurückziehen“;
 * deactivation with a reason. Owner only — the server checks `members.read` / `members.manage` / `invites.manage`.
 */
export function MembersPanel() {
  return (
    <ConvexGuard fallback={loading}>
      <MembersPanelInner />
    </ConvexGuard>
  );
}

function MembersPanelInner() {
  const t = useTranslations("members");
  const members = useAuthedQuery(api.members.list, {});
  const invites = useAuthedQuery(api.invites.list, {});
  const [inviteOpen, setInviteOpen] = useState(false);
  const [disabling, setDisabling] = useState<Member | null>(null);

  if (members === undefined || invites === undefined) return loading;
  const open = invites.filter((i) => i.status === "open");

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <CardTitle>
              <h2>{t("membersTitle")}</h2>
            </CardTitle>
            <CardDescription>{t("membersDescription")}</CardDescription>
          </div>
          <Button className="h-11 md:h-9" onClick={() => setInviteOpen(true)}>
            <UserPlusIcon aria-hidden="true" />
            {t("invite")}
          </Button>
        </CardHeader>
        <CardContent>
          <MemberTable members={members} onDisable={setDisabling} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("openInvites")}</h2>
          </CardTitle>
          <CardDescription>{t("openInvitesDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {open.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("noOpenInvites")}</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {open.map((invite) => (
                <InviteRow key={invite.inviteId} invite={invite} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <DisableDialog member={disabling} onClose={() => setDisabling(null)} />
    </div>
  );
}

function YesNo({ value, label }: { value: boolean; label: string }) {
  const t = useTranslations("common");
  return (
    <span className="inline-flex items-center gap-1">
      {value ? (
        <CheckIcon className="size-4 text-success" aria-hidden="true" />
      ) : (
        <MinusIcon className="size-4 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="sr-only">
        {label}: {value ? t("yes") : t("no")}
      </span>
    </span>
  );
}

function AccessBadge({ member }: { member: Member }) {
  const t = useTranslations("members");
  if (member.access === "active") return null;
  return <Badge variant="secondary">{t(`access.${member.access}`)}</Badge>;
}

function MemberActions({ member, onDisable }: { member: Member; onDisable: (m: Member) => void }) {
  const t = useTranslations("members");
  // The owner row cannot be changed or removed (04 §4.10).
  if (member.role === "owner" || member.access !== "active") return null;
  return (
    <Button variant="outline" size="sm" className="h-11 md:h-8" onClick={() => onDisable(member)}>
      {t("disable")}
      <span className="sr-only"> ({member.email})</span>
    </Button>
  );
}

function MemberTable({ members, onDisable }: { members: Member[]; onDisable: (m: Member) => void }) {
  const t = useTranslations("members");
  const date = (ms: number | null) => (ms === null ? "—" : formatTimestamp(ms));
  return (
    <>
      {/* Desktop: table; narrow main area: cards (04 §4.10 „Mobile: cards“). */}
      <div className="hidden @3xl/main:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.person")}</TableHead>
              <TableHead>{t("columns.role")}</TableHead>
              <TableHead>{t("columns.passkey")}</TableHead>
              <TableHead>{t("columns.totp")}</TableHead>
              <TableHead>{t("columns.validUntil")}</TableHead>
              <TableHead>{t("columns.lastSignIn")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("columns.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow key={m.memberId}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">{m.name ?? m.email}</span>
                    {m.name && <span className="text-muted-foreground text-xs">{m.email}</span>}
                  </div>
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-2">
                    {t(`roles.${m.role}`)} <AccessBadge member={m} />
                  </span>
                </TableCell>
                <TableCell>
                  <YesNo value={m.hasPasskey} label={t("columns.passkey")} />
                </TableCell>
                <TableCell>
                  <YesNo value={m.totpEnabled} label={t("columns.totp")} />
                </TableCell>
                <TableCell className="tabular-nums">{date(m.expiresAt)}</TableCell>
                <TableCell className="tabular-nums" data-volatile="">
                  {m.lastSignInAt === null ? "—" : formatTimestamp(m.lastSignInAt, { withTime: true })}
                </TableCell>
                <TableCell className="text-right">
                  <MemberActions member={m} onDisable={onDisable} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y rounded-lg border @3xl/main:hidden">
        {members.map((m) => (
          <li key={m.memberId} className="flex flex-col gap-2 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{m.name ?? m.email}</span>
              <span>{t(`roles.${m.role}`)}</span>
              <AccessBadge member={m} />
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
              <dt>{t("columns.passkey")}</dt>
              <dd>
                <YesNo value={m.hasPasskey} label={t("columns.passkey")} />
              </dd>
              <dt>{t("columns.totp")}</dt>
              <dd>
                <YesNo value={m.totpEnabled} label={t("columns.totp")} />
              </dd>
              <dt>{t("columns.validUntil")}</dt>
              <dd>{date(m.expiresAt)}</dd>
              <dt>{t("columns.lastSignIn")}</dt>
              <dd data-volatile="">
                {m.lastSignInAt === null ? "—" : formatTimestamp(m.lastSignInAt, { withTime: true })}
              </dd>
            </dl>
            <div>
              <MemberActions member={m} onDisable={onDisable} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function InviteRow({ invite }: { invite: Invite }) {
  const t = useTranslations("members");
  const resend = useMutation(api.invites.resend);
  const revoke = useMutation(api.invites.revoke);
  const showError = useAdapterErrorToast();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-col gap-2 p-3 text-sm @2xl/main:flex-row @2xl/main:items-center">
      <MailIcon className="hidden size-4 shrink-0 text-muted-foreground @2xl/main:block" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{invite.email}</span>
        <span className="text-muted-foreground">
          {t(`roles.${invite.role}`)} ·{" "}
          {invite.sentAt === null
            ? t("notSentYet")
            : t("sentAt", { date: formatTimestamp(invite.sentAt, { withTime: true }) })}{" "}
          · {t("expiresAt", { date: formatTimestamp(invite.expiresAt) })}
        </span>
        {invite.mailOutcome === "failed" && (
          <span role="status" className="text-danger">
            {t("mailFailed")}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-11 md:h-8"
          disabled={busy}
          onClick={() => void run(() => resend({ inviteId: invite.inviteId }), t("resent"))}
        >
          {t("resend")}
          <span className="sr-only"> ({invite.email})</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-11 md:h-8"
          disabled={busy}
          onClick={() => void run(() => revoke({ inviteId: invite.inviteId }), t("revoked"))}
        >
          {t("revoke")}
          <span className="sr-only"> ({invite.email})</span>
        </Button>
      </div>
    </li>
  );
}

function FiscalYearsField({ form, years }: { form: InviteForm; years: number[] }) {
  const t = useTranslations("members");
  const errorId = useId();
  const error = form.formState.errors.fiscalYears?.message;
  return (
    <Controller
      control={form.control}
      name="fiscalYears"
      render={({ field }) => (
        <fieldset
          className="flex flex-col gap-1.5"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        >
          <legend className="mb-1.5 font-medium text-sm">
            {t("fiscalYears")}
            <span aria-hidden="true" className="text-danger">
              {" "}
              *
            </span>
          </legend>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {years.map((year) => (
              <label key={year} className="flex h-11 items-center gap-2 text-sm md:h-8">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={field.value.includes(year)}
                  onChange={(e) =>
                    field.onChange(
                      e.target.checked ? [...field.value, year] : field.value.filter((y: number) => y !== year),
                    )
                  }
                />
                {year}
              </label>
            ))}
          </div>
          {error && (
            <p id={errorId} className="text-danger text-sm">
              {error}
            </p>
          )}
        </fieldset>
      )}
    />
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("members");
  const tCommon = useTranslations("common");
  const formId = useId();
  const create = useMutation(api.invites.create);
  const showError = useAdapterErrorToast();
  const form = useZodForm(inviteSchema, inviteDefaults) as InviteForm;
  const role = useWatch({ control: form.control, name: "role" });
  const today = berlinCalendarDate(Date.now());
  const auditor = role === "auditor";

  const submit = form.handleSubmit(async (values) => {
    try {
      await create(inviteArgsFromForm(values));
      toast.success(t("invited", { email: values.email }));
      form.reset(inviteDefaults);
      onOpenChange(false);
    } catch (e) {
      showError(e);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("inviteTitle")}</DialogTitle>
          <DialogDescription>{t("inviteDescription")}</DialogDescription>
        </DialogHeader>
        <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
          <FormErrorSummary form={form} />
          <TextField form={form} name="email" label={t("email")} type="email" autoComplete="off" required />
          <SelectField
            form={form}
            name="role"
            label={t("role")}
            required
            options={INVITE_ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
            description={t(`roleHints.${role}`)}
          />
          <TextField
            form={form}
            name="validUntil"
            label={t("validUntil")}
            type="date"
            min={addDays(today, 1)}
            {...(auditor ? { max: addDays(today, 30) } : {})}
            required={auditor}
            description={auditor ? t("validUntilAuditor") : t("validUntilHint")}
          />
          {auditor && (
            <>
              <FiscalYearsField form={form} years={selectableFiscalYears(today)} />
              <TextField form={form} name="purpose" label={t("purpose")} required />
              <TextField form={form} name="organisation" label={t("organisation")} />
            </>
          )}
          <p className="rounded-md bg-muted p-3 text-sm">{t("tailnetHint")}</p>
        </form>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" form={formId} className="h-11 md:h-9" disabled={form.formState.isSubmitting}>
            {t("sendInvite")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisableDialog({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const t = useTranslations("members");
  const tCommon = useTranslations("common");
  const reasonId = useId();
  const disable = useMutation(api.members.disable);
  const showError = useAdapterErrorToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const confirm = async (memberId: Id<"members">) => {
    setBusy(true);
    try {
      await disable({ memberId, reason });
      toast.success(t("disabled"));
      setReason("");
      onClose();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={member !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("disableTitle", { email: member?.email ?? "" })}</DialogTitle>
          <DialogDescription>{t("disableDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={reasonId} className="font-medium text-sm">
            {t("disableReason")}
          </label>
          <Textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button
            variant="destructive"
            className="h-11 md:h-9"
            disabled={busy || member === null}
            onClick={() => member && void confirm(member.memberId)}
          >
            {t("disableConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
