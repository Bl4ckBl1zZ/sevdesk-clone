/**
 * Security status page (F12 AUD-020; SEC-01, SEC-06, AO-06, DSGVO-04, GOBD-09, GOBD-22). Pure evaluation of the
 * setup checks — each ok/warning/error with a German remedy. Inputs come from Convex (env presence, members,
 * invites, integrity, checkpoints, location, integrations), from the web server (its env, pins, clock) and from the
 * live probes (`settings.runAccessChecks`: DNS/TLS/api self-test/convex-dash basic auth — deployed stack only).
 */
import { type CalendarDate, daysBetween } from "../time/calendar-date";
import type { CheckStatus } from "./health";

export interface SecurityCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
  remedy?: string;
}

export const CONVEX_SECRET_ENV = [
  "BETTER_AUTH_SECRET",
  "JWKS",
  "OWNER_EMAIL",
  "SERVER_JWKS",
  "CHECKPOINT_SIGNING_KEY_PEM",
] as const;
export const WEB_SECRET_ENV = ["JWT_PRIVATE_KEY_PEM", "APP_ENCRYPTION_KEY"] as const;
export const SECRET_ROTATION_DAYS = 365;

export interface SecurityInput {
  today: string;
  /** This request carries a valid Better Auth session (always true when the page renders). */
  sessionValid: boolean;
  ownerPasskeys: number;
  convexEnv: Readonly<Record<(typeof CONVEX_SECRET_ENV)[number], boolean>>;
  webEnv: Readonly<Record<(typeof WEB_SECRET_ENV)[number], boolean>>;
  /** `SECRETS_ROTATED_ON` (YYYY-MM-DD) from the Convex env; yearly rotation reminder. */
  secretsRotatedOn?: string | undefined;
  auth: { cookieCache: boolean; ipRateLimit: boolean; otpThrottle: boolean };
  /** DSGVO-05: the dev transports write sign-in codes and addresses to the Convex log / a table. */
  authMail: { transport: "cloudflare" | "memory" | "console"; isTest: boolean };
  accessConcept?: { baseDomain: string; confirmedAt: number } | undefined;
  expiredMembersWithSessions: number;
  staleInvites: number;
  integrity: { lastRunAt?: number | undefined; lastRunOk?: boolean | undefined };
  checkpoint: { lastUploadedAt?: number | undefined; lastStatus?: string | undefined };
  serverLocation?: { countryCode: string; isEu: boolean } | undefined;
  /** Enabled integrations with a non-EU endpoint and no AVV confirmation (DSGVO-04). */
  integrationsWithoutAvv: readonly string[];
  pins: { betterAuth: string; convexImage?: string | undefined };
  clock?: { status: CheckStatus; detail: string } | undefined;
  /** Live probes (deployed stack): access/TLS/api/convex-dash results. */
  probes?: readonly SecurityCheck[] | undefined;
}

const DAY_MS = 86_400_000;

const ok = (id: string, label: string, detail?: string): SecurityCheck => ({
  id,
  label,
  status: "ok",
  ...(detail ? { detail } : {}),
});
const bad = (id: string, label: string, status: CheckStatus, detail: string, remedy: string): SecurityCheck => ({
  id,
  label,
  status,
  detail,
  remedy,
});

/** AUD-020 / GOBD-09: the setup checks of /einstellungen/system/sicherheit. */
export function evaluateSecurity(i: SecurityInput, now: number): SecurityCheck[] {
  const out: SecurityCheck[] = [];
  out.push(
    i.sessionValid
      ? ok("session", "Anmeldung mit gültiger Sitzung")
      : bad("session", "Anmeldung mit gültiger Sitzung", "error", "Keine gültige Sitzung.", "Neu anmelden."),
  );
  out.push(
    i.ownerPasskeys > 0
      ? ok("passkey", "Inhaber hat einen Passkey", `${i.ownerPasskeys} Passkey(s)`)
      : bad(
          "passkey",
          "Inhaber hat einen Passkey",
          "error",
          "Kein Passkey registriert.",
          "Unter Einstellungen › Mitglieder › Eigenes Konto einen Passkey hinzufügen.",
        ),
  );
  const missingConvex = CONVEX_SECRET_ENV.filter((n) => !i.convexEnv[n]);
  out.push(
    missingConvex.length === 0
      ? ok("convex-env", "Geheimnisse im Convex-Backend gesetzt")
      : bad(
          "convex-env",
          "Geheimnisse im Convex-Backend gesetzt",
          "error",
          `Fehlt: ${missingConvex.join(", ")}`,
          "Mit `pnpm convex env set NAME …` setzen (08 §5.2).",
        ),
  );
  const missingWeb = WEB_SECRET_ENV.filter((n) => !i.webEnv[n]);
  out.push(
    missingWeb.length === 0
      ? ok("web-env", "Geheimnisse im Web-Container gesetzt")
      : bad(
          "web-env",
          "Geheimnisse im Web-Container gesetzt",
          "error",
          `Fehlt: ${missingWeb.join(", ")}`,
          "In der Dokploy-Umgebung des Web-Containers setzen (08 §5.1).",
        ),
  );
  if (!i.secretsRotatedOn) {
    out.push(
      bad(
        "secret-age",
        "Alter der Geheimnisse",
        "warning",
        "Rotationsdatum unbekannt.",
        "Nach der nächsten Rotation SECRETS_ROTATED_ON (JJJJ-MM-TT) im Convex-Backend setzen.",
      ),
    );
  } else {
    const age = daysBetween(i.secretsRotatedOn as CalendarDate, i.today as CalendarDate);
    out.push(
      age > SECRET_ROTATION_DAYS
        ? bad(
            "secret-age",
            "Alter der Geheimnisse",
            "warning",
            `Zuletzt rotiert vor ${age} Tagen.`,
            "Geheimnisse jährlich rotieren (Runbook „Schlüssel rotieren“).",
          )
        : ok("secret-age", "Alter der Geheimnisse", `Zuletzt rotiert vor ${age} Tagen.`),
    );
  }
  const authProblems = [
    ...(i.auth.cookieCache ? ["Cookie-Cache ist eingeschaltet"] : []),
    ...(i.auth.ipRateLimit ? ["IP-Ratenlimit von Better Auth ist eingeschaltet"] : []),
    ...(!i.auth.otpThrottle ? ["Drosselung der Anmeldecodes fehlt"] : []),
  ];
  out.push(
    authProblems.length === 0
      ? ok(
          "auth-config",
          "Sitzungs- und Anmeldeeinstellungen",
          "Cookie-Cache aus, IP-Limit aus, Code-Drosselung aktiv.",
        )
      : bad(
          "auth-config",
          "Sitzungs- und Anmeldeeinstellungen",
          "error",
          authProblems.join("; "),
          "convex/auth.ts prüfen (02 §4.2).",
        ),
  );
  out.push(
    i.authMail.transport === "cloudflare" || i.authMail.isTest
      ? ok("debug-logs", "Keine personenbezogenen Daten in Debug-Logs")
      : bad(
          "debug-logs",
          "Keine personenbezogenen Daten in Debug-Logs",
          "error",
          `AUTH_MAIL_SENDER=${i.authMail.transport}: Anmeldecodes und E-Mail-Adressen landen im Log bzw. in der Datenbank.`,
          "AUTH_MAIL_SENDER im Convex-Backend entfernen (nur für Entwicklung/Test, DSGVO-05).",
        ),
  );
  out.push(
    i.accessConcept
      ? ok("access-concept", "Zugriffskonzept dokumentiert", `Nur im Tailnet unter ${i.accessConcept.baseDomain}`)
      : bad(
          "access-concept",
          "Zugriffskonzept dokumentiert",
          "error",
          "Nicht erfasst.",
          "Einrichtung › Zugriff ausfüllen.",
        ),
  );
  out.push(
    i.expiredMembersWithSessions === 0
      ? ok("expired-sessions", "Abgelaufene Mitglieder ohne Sitzungen")
      : bad(
          "expired-sessions",
          "Abgelaufene Mitglieder ohne Sitzungen",
          "error",
          `${i.expiredMembersWithSessions} abgelaufene(s) Mitglied(er) mit Sitzung.`,
          "Unter Mitglieder „Sitzungen abmelden“ wählen; der Ablauf-Job prüft stündlich.",
        ),
  );
  out.push(
    i.staleInvites === 0
      ? ok("stale-invites", "Keine abgelaufenen offenen Einladungen")
      : bad(
          "stale-invites",
          "Keine abgelaufenen offenen Einladungen",
          "warning",
          `${i.staleInvites} Einladung(en) älter als ihre Gültigkeit.`,
          "Unter Mitglieder widerrufen oder neu senden.",
        ),
  );
  out.push(
    i.integrity.lastRunAt === undefined
      ? bad(
          "integrity",
          "Letzte Integritätsprüfung",
          "warning",
          "Noch keine Prüfung gelaufen.",
          "Die Prüfung läuft nächtlich automatisch.",
        )
      : i.integrity.lastRunOk
        ? ok("integrity", "Letzte Integritätsprüfung", "Ohne Befund.")
        : bad(
            "integrity",
            "Letzte Integritätsprüfung",
            "error",
            "Befund offen.",
            "Einstellungen › Protokoll › Integrität prüfen.",
          ),
  );
  const checkpointAge = i.checkpoint.lastUploadedAt === undefined ? null : (now - i.checkpoint.lastUploadedAt) / DAY_MS;
  out.push(
    checkpointAge === null
      ? bad(
          "checkpoint",
          "Letzter Prüfpunkt hochgeladen",
          "warning",
          "Noch kein Prüfpunkt hochgeladen.",
          "R2-Prüfpunkt-Bucket einrichten (Integrationen).",
        )
      : checkpointAge > 2
        ? bad(
            "checkpoint",
            "Letzter Prüfpunkt hochgeladen",
            "warning",
            `Vor ${Math.floor(checkpointAge)} Tagen.`,
            "R2-Zugang prüfen; der Upload läuft täglich.",
          )
        : ok("checkpoint", "Letzter Prüfpunkt hochgeladen"),
  );
  out.push(
    !i.serverLocation
      ? bad(
          "location",
          "Serverstandort in der EU",
          "error",
          "Nicht erfasst.",
          "Einrichtung › Zugriff ausfüllen (§ 146 Abs. 2 AO).",
        )
      : i.serverLocation.isEu
        ? ok("location", "Serverstandort in der EU", i.serverLocation.countryCode)
        : bad(
            "location",
            "Serverstandort in der EU",
            "error",
            `Standort ${i.serverLocation.countryCode} außerhalb der EU.`,
            "Genehmigung des Finanzamts nach § 146 Abs. 2b AO erforderlich.",
          ),
  );
  out.push(
    i.integrationsWithoutAvv.length === 0
      ? ok("dpa", "Externe Dienste mit AVV")
      : bad(
          "dpa",
          "Externe Dienste mit AVV",
          "error",
          `Ohne AVV oder außerhalb der EU: ${i.integrationsWithoutAvv.join(", ")}`,
          "Unter Integrationen den AVV bestätigen oder den Dienst abschalten (Art. 28 DSGVO).",
        ),
  );
  out.push(
    /^1\.6\.\d+$/.test(i.pins.betterAuth)
      ? ok("pin-better-auth", "better-auth auf 1.6.x festgelegt", i.pins.betterAuth)
      : bad(
          "pin-better-auth",
          "better-auth auf 1.6.x festgelegt",
          "error",
          i.pins.betterAuth,
          "Version in package.json exakt auf 1.6.x pinnen.",
        ),
  );
  out.push(
    i.pins.convexImage === undefined
      ? {
          id: "pin-convex",
          label: "Convex-Image festgelegt",
          status: "unknown",
          detail: "Nur auf dem Server prüfbar (CONVEX_SHA).",
        }
      : /^[0-9a-f]{7,40}$/.test(i.pins.convexImage)
        ? ok("pin-convex", "Convex-Image festgelegt", i.pins.convexImage)
        : bad(
            "pin-convex",
            "Convex-Image festgelegt",
            "error",
            i.pins.convexImage,
            "CONVEX_SHA auf einen Commit-SHA setzen (02 §2).",
          ),
  );
  if (i.clock) out.push({ id: "clock", label: "Uhrzeit (NTP)", ...i.clock });
  if (i.probes && i.probes.length > 0) out.push(...i.probes);
  else {
    out.push({
      id: "probes",
      label: "Hosts, TLS, api.-Selbsttest, Dashboard-Schutz",
      status: "unknown",
      detail: "Live-Prüfung starten (läuft nur auf dem Server unter BASE_DOMAIN).",
    });
  }
  return out;
}
