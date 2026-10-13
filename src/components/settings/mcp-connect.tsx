"use client";

import { BanIcon, CheckIcon, KeyRoundIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { apiHostUrl, useLocationHost } from "./api-host";
import { ApiKeyCreateDialog } from "./api-keys-admin";
import { CopyButton } from "./copy-button";

const MCP_PATH = "/api/mcp";
/** Shown when the api host cannot be derived from the current location (localhost, IP). */
const PLACEHOLDER_URL = `https://api.<Ihre-Domain>${MCP_PATH}`;
/** Environment-variable references kept literally in the snippets (expanded by Claude Code / mcp-remote). */
const ENV_KEY = ["$", "{RECHNUNG_MCP_KEY}"].join("");
const ENV_AUTH = ["$", "{AUTH_HEADER}"].join("");

/** The three client configurations of 06 §6 with the endpoint URL filled in. */
export function mcpSnippets(url: string) {
  return {
    claudeCode: `claude mcp add --transport http rechnungen ${url} --header "Authorization: Bearer $RECHNUNG_MCP_KEY" --scope user`,
    mcpJson: JSON.stringify(
      { mcpServers: { rechnungen: { type: "http", url, headers: { Authorization: `Bearer ${ENV_KEY}` } } } },
      null,
      2,
    ),
    desktop: JSON.stringify(
      {
        mcpServers: {
          rechnungen: {
            command: "npx",
            args: ["-y", "mcp-remote", url, "--header", `Authorization:${ENV_AUTH}`],
            env: { AUTH_HEADER: "Bearer sk_live_…" },
          },
        },
      },
      null,
      2,
    ),
  };
}

/**
 * `/einstellungen/mcp` (06 §6, MCP-001): supported clients (Claude Code directly, Claude Desktop via the local
 * `mcp-remote` bridge; claude.ai web/mobile and custom connectors cannot reach the tailnet), copyable snippets with
 * the endpoint URL, „Schlüssel für Claude erstellen“ (preset „Claude (MCP), sicher“) and what Claude may do.
 */
export function McpConnect() {
  const t = useTranslations("mcpConnect");
  const derived = apiHostUrl(useLocationHost(), MCP_PATH);
  const url = derived ?? PLACEHOLDER_URL;
  const snippets = mcpSnippets(url);
  const [creating, setCreating] = useState(false);
  const notSupportedId = useId();

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("clientsTitle")}</h2>
          </CardTitle>
          <CardDescription>{t("intro")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-1.5">
            <span className="font-medium">{t("endpoint")}</span>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-3 py-2">{url}</code>
              <CopyButton value={url} label={t("copySnippet", { title: t("endpoint") })} />
            </div>
            {!derived && <p className="text-muted-foreground">{t("endpointFallback")}</p>}
          </div>
          <ul className="flex flex-col gap-2">
            <li className="flex items-start gap-2">
              <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
              {t("claudeCode")}
            </li>
            <li className="flex items-start gap-2">
              <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
              {t("claudeDesktop")}
            </li>
          </ul>
          <section
            role="note"
            aria-labelledby={notSupportedId}
            className="flex items-start gap-2 rounded-md border border-warning bg-warning/10 p-3"
          >
            <BanIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="flex flex-col gap-1">
              <h3 id={notSupportedId} className="font-medium">
                {t("notSupportedTitle")}
              </h3>
              <p>{t("notSupported")}</p>
            </div>
          </section>
          <p className="text-muted-foreground">{t("prerequisites")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <CardTitle>
              <h2>{t("keyTitle")}</h2>
            </CardTitle>
            <CardDescription>{t("keyDescription")}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button className="h-11 md:h-9" onClick={() => setCreating(true)}>
              <KeyRoundIcon aria-hidden="true" />
              {t("createKey")}
            </Button>
            <Link href="/einstellungen/api" className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}>
              {t("manageKeys")}
            </Link>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("snippetsTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Snippet title={t("claudeCodeSnippet")} value={snippets.claudeCode} />
          <Snippet title={t("mcpJsonSnippet")} value={snippets.mcpJson} />
          <Snippet title={t("desktopSnippet")} value={snippets.desktop} hint={t("desktopHint")} />
        </CardContent>
      </Card>

      <div className="grid gap-6 @3xl/main:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("canTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              {(["read", "drafts", "legal"] as const).map((k) => (
                <li key={k} className="flex items-start gap-2">
                  <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                  {t(`can.${k}`)}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("cannotTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              {(["delete", "keys", "purge"] as const).map((k) => (
                <li key={k} className="flex items-start gap-2">
                  <XIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                  {t(`cannot.${k}`)}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {creating && <ApiKeyCreateDialog initialPreset="claude_safe" onClose={() => setCreating(false)} />}
    </div>
  );
}

function Snippet({ title, value, hint }: { title: string; value: string; hint?: string }) {
  const t = useTranslations("mcpConnect");
  const titleId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 id={titleId} className="font-medium text-sm">
          {title}
        </h3>
        <CopyButton value={value} label={t("copySnippet", { title })} />
      </div>
      {/* Wrapped instead of scrolled: no keyboard-unreachable scroll region on phones. */}
      <section aria-labelledby={titleId}>
        <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
          <code>{value}</code>
        </pre>
      </section>
      {hint && <p className="text-muted-foreground text-sm">{hint}</p>}
    </div>
  );
}
