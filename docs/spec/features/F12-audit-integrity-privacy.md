# F12 — Audit Log, Integrity, Auditor Access, Retention, Privacy and Notifications
> **Status:** v1.1 · 2026-10-12 (platform update: login + roles replace the gate, auditor = time-limited member, checkpoints and backups on Cloudflare R2, no public host; Verfahrensdokumentation sections Bankdaten and Datenmigration, processors list) · **Phases:** P0 (audit log, hash chain, immutability triggers, mutation inventory, auth audit and security checks), P1 (integrity checks + signed checkpoints, audit viewer, Verfahrensdokumentation v1, notifications, backup status), P3 (auditor access Z1 via the `auditor` role, retention engine + purge, DSGVO tools, Verfahrensdokumentation complete) · **sevdesk parity:** research 00 §16.1, §16.3 (no Verfahrensdokumentation template, auditor = extra user), §17; research 02 MUST #6, NICE #32 · **Edge cases:** [10-edge-cases.md](../10-edge-cases.md) EC-027, EC-180–EC-186, EC-188; RI-13, RI-14, RI-15, RI-20 · **Compliance:** GOBD-06, GOBD-09, GOBD-10, GOBD-11, GOBD-20, GOBD-21, GOBD-22, GOBD-23, SEC-01..07, DSGVO-01..06, AO-06

## 1. Scope (in / out, and what we do better than sevdesk)

**In scope**
- **Audit log** (append-only, hash-chained) content rules, action taxonomy, viewer with actor filters (incl. „Was hat Claude heute geändert?"), per-record history, export.
- **Integrity**: nightly verification (chain, artifacts, snapshots, invariants), startup check, **signed daily checkpoints** exported off-host (SEC-04), incident handling.
- **Immutability triggers** (GOBD-06) and the **mutation-inventory test**.
- **Security status page and setup checks** for login + tailnet (SEC-01, SEC-06, AO-06, GOBD-22 clock skew); audit of sign-ins and member changes.
- **Auditor read-only access** (Z1, SEC-03) as a **time-limited member with role `auditor`** (02 §4.3).
- **Verfahrensdokumentation generator** (GOBD-10): chapters, auto-filled content, owner inputs, PDF export, versioning.
- **Retention engine and purge** (GOBD-20/21) with Ablaufhemmung confirmation and tombstones.
- **DSGVO tools** (DSGVO-02/03): request register with deadlines, erasure → restriction → purge due date → **manual purge worklist** (purges are never automatic), access/portability export.
- **Notifications center**: kinds, severities, channels (in-app, e-mail, ntfy), digest.
- **Backup status** (read from the R2 backup bucket) and restore-drill log (operations in [08-deployment.md §7](../08-deployment.md#7-backups-and-restore-sec-05-gobd-09)).

**Out of scope**
- Login mechanics, member and invite management (02 §4.2–4.3, 04 §4.9–4.10). This file specifies the auditor role's behaviour, the audit of auth events and the security checks.
- SIEM integration, RFC 3161 timestamping (COULD), qualified archiving certification (IDW PS 880).
- The ops side of backups (Dokploy jobs, restore runbook) — 08-deployment.

**Better than sevdesk**
- sevdesk shows no hash chain, no integrity reports, no Verfahrensdokumentation template, auditor access = paid extra user, no GDPdU export, no DSGVO request tooling (research 00 §16.3). We make tamper evidence visible and provable off-host, generate the Verfahrensdokumentation, and show exactly what every API key and Claude changed.

## 2. User stories

| # | As … | I want … | so that … |
|---|---|---|---|
| US-01 | owner | to see everything Claude (MCP) changed today with before/after | I can trust and verify AI work |
| US-02 | owner | a daily proof off-host that the books weren't altered | a Betriebsprüfer accepts my records even if someone had database access |
| US-03 | owner | a loud alarm if the chain breaks or the access configuration is wrong | problems never stay hidden |
| US-04 | Betriebsprüfer | a time-limited read-only access restricted to the audit years | I can perform Z1 access without risk of changes |
| US-05 | owner | a generated Verfahrensdokumentation that I only need to complete | I meet GOBD-10 without writing 40 pages |
| US-06 | owner | to purge data after retention, safely | I comply with DSGVO without breaking GoBD |
| US-07 | owner | to handle a customer's deletion/access request within the deadline | DSGVO requests are answered correctly and on time |
| US-08 | owner | notifications on my phone (ntfy) for critical events | I react fast without opening the app |
| US-09 | owner | to see that backups ran and when I last tested a restore | GOBD-09/SEC-05 are visibly fulfilled |

## 3. Functional requirements

### 3.1 Audit, integrity, immutability, security checks, auditor access, Verfahrensdokumentation, backups (AUD)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| AUD-001 | Every state-changing operation on any table (create, update, delete of drafts, lifecycle transitions, settings changes, imports, exports, restores, purges, key/webhook management, member/invite changes incl. auditors, integrity runs; sign-in/sign-out via Better Auth session triggers) writes ≥ 1 `auditLog` entry **in the same transaction** via the `convex/functions.ts` wrappers; the wrapper aborts the transaction with `audit_missing` if a write happened without an audit entry | MUST | P0 | GOBD-06, SEC-02 |
| AUD-002 | Entry content: `seq` (strictly increasing, gapless), `at` (UTC ms), actor in the canonical `"<kind>:<id>"` form (02 §4.4: `user:<betterAuthUserId>` + `actorRole` (`owner`/`bookkeeper`/`viewer`/`auditor`) + `sessionId`, `api-key:<keyId>` + key name, `mcp:<keyId>` + key name + MCP client name/version, `system:<job>` — `system:cron.<job>` for scheduled jobs, 03 §0.1; `portal:` reserved; e-mail, key name and MCP client stored separately as `actorLabel`/`client`), channel, user agent, `requestId` (client IP: not available behind the tailnet edge, field normally absent, 02 §4.1), `action` (taxonomy §4.1), `entity { table, id, label }`, `diff { before, after }` (changed fields only for updates; full content for creates and draft deletions), `reason` (mandatory where rules require it: backdating, overrides, purges, corrections), `prevHash`, `hash` | MUST | P0 | GOBD-06, SEC-02, DSGVO-06 |
| AUD-003 | Secrets are redacted **before** hashing and storage (API key hashes, encrypted secrets, tokens, passwords, IBAN in full only where it is business data); a redaction list is unit-tested; diffs > 64 KB are stored as a blob in file storage and referenced by `{ storageId, sha256 }` inside the hashed entry | MUST | P0 | DSGVO-05, SEC-06 |
| AUD-004 | Hash chain: `hash = SHA-256(prevHash ‖ JCS(entry without hash))` (JCS = RFC 8785 canonical JSON, UTF-8); genesis `prevHash` = SHA-256(`"genesis:" + INSTANCE_NAME`); `seq` and `prevHash` assigned inside the writing transaction by reading the head (`by_seq` desc) — Convex serialisability guarantees a total order; bulk jobs batch to limit contention | MUST | P0 | GOBD-06, SEC-04 |
| AUD-005 | `auditLog` is protected: no updates, no deletes (trigger + model layer); the only exception is the prefix purge (PRV-008) which leaves a signed chain anchor | MUST | P0 | GOBD-06 |
| AUD-006 | **Audit viewer** `/einstellungen/audit`: filters period, actor type, specific actor (API key / MCP key by name), channel, action, entity table/ID, text; presets „Was hat Claude heute geändert?" (actor type mcp, today 00:00 Europe/Berlin → now), „API-Schlüssel {name}", „Einstellungsänderungen", „Festschreibungen", „Exporte & Importe", „Gelöschte Entwürfe", „Prüferzugriffe", „Integrität"; timeline with actor badges (Du / Name + Rolle · API „website" · Claude (MCP) · Prüfer · System), side-by-side diff, link to the entity; per-entry chain status („verifiziert bis seq {n} am {datum}") | MUST | P1 | GOBD-06, SEC-02 |
| AUD-007 | Per-record history: every detail page has a „Verlauf" tab with that entity's audit entries (04-ui-ux §4.2); related entities (e.g. invoice → payments, artifacts, send log) included | MUST | P1 | GOBD-01 |
| AUD-008 | Audit export: CSV/JSON of a filtered range including `seq`, `hash`, `prevHash`, so a third party can re-verify the segment against a checkpoint; included in GDPdU (`protokoll.csv`, F09) | MUST | P1 | GOBD-11 |
| AUD-009 | Reads are not logged except: auditor access (every request), downloads of archived originals (`original=true`), exports, DSGVO exports, and access to settings secrets screens | MUST | P1 | SEC-03, DSGVO-06 |
| AUD-010 | **Immutability triggers** on every 🔒 table (03 §11 matrix): updates may only touch the whitelisted fields for the record's state, transitions must follow the lifecycle state machine, deletes only for drafts, and nothing dated in a locked period changes after `periods.lockedAt` (RI-13); violations throw `immutable_record` / `period_locked` and are logged as `security.write_rejected` | MUST | P0 | GOBD-06 |
| AUD-011 | Only `convex/model/**` calls `ctx.db.insert/patch/replace/delete` (lint rule, CI fails otherwise); the **only allowlisted exception is `convex/betterAuth/**`** (Better Auth component adapter for auth tables, 02 §3); triggers are registered once in `convex/functions.ts` so every public and internal mutation passes through them | MUST | P0 | GOBD-06 |
| AUD-012 | **Mutation-inventory test**: `convex/mutation-inventory.json` lists every public and internal mutation/action with tables written, audit actions and required scope; CI (1) fails if a function is missing from or stale in the inventory (functions under `convex/betterAuth/**` are listed in an explicit allowlist section, may write only the component's auth tables and are checked for that); (2) for each mutation, runs generated arguments against seeded finalised/locked records of every protected table and asserts `immutable_record`/`period_locked`; (3) asserts that every successful write produced an audit entry | MUST | P0 | GOBD-06 |
| AUD-013 | **Nightly integrity job** `integrity.verify` (02:00): (a) chain verification incremental from the last verified seq, full chain every Sunday; (b) head vs the latest signed checkpoint (signature and seq/hash continuity) and vs the off-host copy in the R2 checkpoint bucket; (c) re-hash artifacts created since the last run + a random 2 % sample + all monthly; (d) recompute `snapshotHash` for documents finalised since the last run + sample; (e) all RI-* invariants (10-edge-cases §2); (f) counts of append-only tables ≥ the previous checkpoint's counts; results in `integrityRuns` | MUST | P1 | SEC-04, GOBD-09 |
| AUD-014 | **Startup check** (web boot and every 6 h): latest checkpoint signature + head continuity (fast); failure → same alerting as AUD-015 | MUST | P1 | SEC-04 |
| AUD-015 | Integrity failure (ERROR) → red banner on every page, e-mail + ntfy (critical), webhook `integrity.check_failed`, `integrityRuns` findings with the exact entity and first broken `seq`; **finalising new documents is blocked until the owner acknowledges** with a note (acknowledgement does not alter data; audited `integrity.acknowledge`); runbook link | MUST | P1 | SEC-04 |
| AUD-016 | **Signed daily checkpoint** (02:30): `{ instance, date, lastSeq, lastHash, counts per protected table, artifactsCount, journalSeq, appVersion, schemaVersion, prevCheckpointHash }` as JWS (ES256, key `CHECKPOINT_SIGNING_KEY_PEM`, `kid`), stored in `integrityCheckpoints` and uploaded to the **dedicated R2 checkpoint bucket** `checkpoints/YYYY/MM/DD.jws` (10 years; an R2 bucket-lock retention rule is recommended, optional; 08 §7); optional e-mail copy to the owner (Cloudflare, 02 §9); upload failures retried hourly, notification after 2 consecutive failures | MUST | P1 | SEC-04 |
| AUD-017 | Checkpoint verification tool: UI upload „Prüfpunkt verifizieren" and CLI `pnpm integrity:verify --checkpoint <file\|r2-url>` verify signature and that the current chain contains `lastSeq/lastHash`; the public key fingerprint is printed in the Verfahrensdokumentation | MUST | P1 | SEC-04, GOBD-10 |
| AUD-018 | Optional RFC 3161 timestamp of each checkpoint from a configured EU TSA (stored next to the JWS) | COULD | P3 | SEC-04 |
| AUD-019 | **Clock monitoring**: every 10 min the web server compares its clock with NTP (configurable EU pool, default `ptbtime1.ptb.de`) and with Convex's `Date.now()`; skew > 2 s → warning finding and banner (GOBD-22); skew > 60 s → finalisation and any business-date-assigning action refused with `clock_skew` (EC-027) until resolved | MUST | P1 | GOBD-22 |
| AUD-020 | **Security status page** `/einstellungen/system/sicherheit` (owner; setup checks, each ok/warn/fail with remedy): this request carries a valid Better Auth session and the owner has ≥ 1 passkey; `BETTER_AUTH_SECRET`, `JWKS`, `OWNER_EMAIL`, `SERVER_JWKS` set (Convex) and their age (rotation reminder yearly); cookie cache off, Better Auth IP rate limit off, OTP throttle active; access concept documented (02 §4); every host of `BASE_DOMAIN` resolves to the Caddy tailnet service; `api.` self-test (`https://api.<BASE_DOMAIN>/` and `/einstellungen` → 404, port 8443 serves only `/api/v1`); `convex-dash.` requires basic auth (unauthenticated probe → 401); TLS ≥ 1.2 and wildcard certificate expiry > 14 days; `JWT_PRIVATE_KEY_PEM`, `APP_ENCRYPTION_KEY`, `CHECKPOINT_SIGNING_KEY_PEM` present; members with expired `expiresAt` still holding sessions (must be 0); invites older than their validity; last integrity run green; last checkpoint uploaded; backups fresh (AUD-026); server location EU (AO-06); external services with non-EU endpoints and missing AVV (DSGVO-04); clock skew; Convex image pinned; `better-auth` pinned to 1.6.x; einvoice-tools reachable; Cloudflare Email reachable | MUST | P0/P1 | SEC-01, SEC-06, AO-06, DSGVO-04, GOBD-22 |
| AUD-021 | **Fail closed:** in production `web` refuses to start without `APP_ENCRYPTION_KEY` and `JWT_PRIVATE_KEY_PEM`, and Convex auth functions refuse to run without `BETTER_AUTH_SECRET`, `JWKS`, `OWNER_EMAIL`, `PASSKEY_RP_ID`; every page, Server Action, route handler and public Convex function rejects requests without a valid session/role or API key (no anonymous code path except `/anmelden/**`, `/api/auth/**`, `/api/health`); the setup wizard cannot be completed while any SEC check fails (EC-185) | MUST | P0 | SEC-01 |
| AUD-022 | **Auditor access (Z1)** as a member (02 §4.3): the owner invites the Betriebsprüfer's e-mail with role `auditor`, organisation, purpose/Aktenzeichen, allowed fiscal years and `expiresAt` (max 30 days per grant, extendable with reason, `members.auditor.extensions`); the auditor signs in with e-mail code (passkey optional) from a device **inside the tailnet**: on-site on a device provided by the owner (default) or remotely after the owner admits the auditor's device/user with a grant limited to the Caddy service tcp:443 (Verfahrensdokumentation „Prüferzugang-Anleitung"; remove the grant at expiry). Expiry revokes all sessions (`members.expire` cron); the owner can deactivate the member immediately. There is no token link and no public route | MUST | P3 | SEC-03, GOBD-11 |
| AUD-023 | Auditor session: read-only UI (lists, documents with original artifacts, journal, accounts, reports incl. CSV downloads, audit log, Verfahrensdokumentation, and the **Z3 (GDPdU) packages the owner generated** for the granted years, downloadable from the UI); data limited to the granted fiscal years (master data needed to understand them is visible); no settings secrets, API keys, webhooks, members, DSGVO register; **every write returns 403** for role `auditor` (Server Actions, route handlers, Convex mutations — automated route-table test); every request audited `auditor.access`; first sign-in notifies the owner | MUST | P3 | SEC-03, GOBD-11 |
| AUD-024 | **Verfahrensdokumentation generator** (`/einstellungen/verfahrensdokumentation`): chapters §4.6, each with status „automatisch", „vollständig", „Angaben fehlen"; auto-filled sections render live from settings, versions and rule tables; owner sections are structured forms (no free-form-only); release („Freigeben") requires all mandatory owner inputs | MUST | P1 (v1) / P3 (complete) | GOBD-10, SEC-07, DSGVO-01, GOBD-08 |
| AUD-025 | Versioning: each release is an immutable `verfahrensdokuVersions` row (version number, validFrom, released by, source JSON, PDF/A, SHA-256, retention end of the year superseded + 10 years); a watch list of relevant changes (legal form, method, chart, access concept and roles, backup config, integrations/OCR, number ranges, retention settings, software minor version, rule-table versions, posting-matrix version) marks the current version „Aktualisierung erforderlich" with a diff and a notification; the change history chapter is generated from audit entries + bundled release notes | MUST | P1 | GOBD-10, GOBD-20 |
| AUD-026 | **Backup status** (`/einstellungen/system/backups`): reads the R2 backup bucket with read-only credentials: latest object time and size for `postgres/`, `convex-export/`, `convex-volume/`, plus the latest object in the R2 checkpoint bucket; whether a bucket-lock rule exists on the checkpoint bucket (recommended); thresholds: Postgres/export > 26 h → warning, > 50 h → error; volume > 8 days → warning | MUST | P1 | SEC-05, GOBD-09 |
| AUD-027 | Restore-drill log: form (date, backup object used, target environment, `integrity.verify` result, chain head equal to the production checkpoint ✓/✗, notes) → `system.restore_drill` audit entry; monthly reminder; > 35 days since the last drill → warning; restores into production are logged as `system.restore` with the restored head and the gap to the latest checkpoint (EC-183) | MUST | P1 | SEC-05, GOBD-09 |
| AUD-028 | Migration safety: every schema migration runs with RI-01/04/14 checks before and after (EC-184); migrations never rewrite snapshot, artifact or audit content; a `system.migration` audit entry records name and counts | MUST | P0 | GOBD-23 |

### 3.2 Retention, purge and DSGVO (PRV)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| PRV-001 | Retention classes per record type (§4.7) with `retentionUntil` = 31.12. of (trigger year + N); computed at finalisation/creation and stored; the rule table is versioned | MUST | P1 | GOBD-20 |
| PRV-002 | No deletion of any record before `retentionUntil` on any path (trigger-enforced, RI-20) | MUST | P1 | GOBD-21 |
| PRV-003 | Monthly `retention.scan` lists purge-eligible records grouped by class and year; notification „{n} Datensätze können gelöscht werden"; purge itself is always manual | MUST | P3 | GOBD-21 |
| PRV-004 | **Betriebsprüfung-Modus** (switch with reason and years): while active, no purge is possible for any year, and auditor grants are suggested | MUST | P3 | GOBD-21 |
| PRV-005 | **Purge wizard** (owner UI only, never API/MCP): select batch → preview (counts, examples, related files) → Ablaufhemmung checklist (all must be confirmed „trifft nicht zu"): laufende oder angekündigte Außenprüfung, offene Einsprüche/Klagen, Steuerbescheide unter Vorbehalt der Nachprüfung (§164 AO) oder vorläufig (§165 AO) für die betroffenen Jahre, laufende Steuerfahndung/Strafverfahren, zivilrechtliche Verfahren/Aufbewahrung aus anderen Gründen → type „ENDGÜLTIG LÖSCHEN" → job | MUST | P3 | GOBD-21 |
| PRV-006 | Purge job: deletes files from storage, removes personal data, and replaces each protected record with a **tombstone** (`purgeTombstones`: table, id, retention class, retentionUntil, SHA-256 of the canonical content, batch id, purged at); the batch is audited with non-personal data only; a copy of the purge log is uploaded to the R2 checkpoint bucket `purges/` | MUST | P3 | GOBD-21, DSGVO-02 |
| PRV-007 | Staged purge for interlinked data: a contact master record is anonymised only when no record referencing it is still within retention; journal lines (10 y) keep account, amount and Belegfeld text but lose `contactId` links once the contact is anonymised; documents (8 y) can be purged while the journal (10 y) remains | MUST | P3 | GOBD-20, DSGVO-02 |
| PRV-008 | Audit-log purge only as a **prefix** (all entries with `seq ≤ n` whose retention expired): a signed **chain anchor** (`{ seq: n, hash }`, JWS, uploaded off-host) is created first; verification thereafter starts at the anchor | MUST | P3 | GOBD-06, GOBD-21 |
| PRV-009 | After a restore from backup, `retention.replayPurges` re-applies all purge batches from the off-host purge log so purged data does not reappear | MUST | P3 | DSGVO-02, SEC-05 |
| PRV-010 | **DSGVO request register** (`dsgvoRequests`): kinds access (Art. 15), rectification (16), erasure (17), restriction (18), portability (20), objection (21); received at, channel, data subject (contact or free name/e-mail), identity verified (method), `dueAt` = received + 1 month (same calendar day; last day of month if missing; next working day if weekend/holiday), extension up to +2 months with reason and notice date (Art. 12 Abs. 3), status `open` → `in_progress` → `done`/`rejected` (reason, Art. 12 Abs. 5) or `extended`; reminders at due − 7 and due − 1 days; overdue → error notification | MUST | P3 | DSGVO-02, DSGVO-03 |
| PRV-011 | **Erasure request flow**: preview in three buckets — (1) delete now: data not under retention (contact notes/activities, tags, drafts, portal view logs, marketing flags; the whole contact if it has no retained records); (2) restrict: retained records (invoices, vouchers, journal, letters); (3) purge due date: per class = max `retentionUntil` of the records referencing the person (only a due date for the manual purge worklist, nothing is purged automatically), staged per PRV-007 → execute: deletes bucket 1, sets `contacts.dsgvo.restrictedAt/deletionRequestedAt/scheduledPurgeAt`, revokes portal links (only once F10 exists), stops marketing/CRM processing; confirmation letter template | MUST | P3 | DSGVO-02 |
| PRV-012 | **Restricted contacts**: hidden from lists, search, autocomplete and MCP/REST lists; cannot be used for new documents, e-mails or portal links; existing open receivables may still be dunned (legal claims, Art. 18 Abs. 2) with a warning; statutory exports (DATEV, GDPdU, auditor) still include them; REST `GET /contacts/{id}` returns `410 contact_restricted` with minimal data unless the key has `audit:read` | MUST | P3 | DSGVO-02 |
| PRV-013 | **Access/portability export** per data subject (job): ZIP with `daten.json` (contact, addresses, channels, activities, documents metadata, payments, mandates, portal acceptances/withdrawals, VAT-ID checks, time entries if linked, audit entries referencing the contact), the document PDFs/XMLs, and `auskunft.pdf` with the Art. 15 information (purposes, categories, recipients (incl. a Steuerberater, if any) and processors from the external-services list, retention periods per class, source, rights) generated from the Art. 30 record; portability = `daten.json` subset of data provided by the subject; export audited | MUST | P3 | DSGVO-03, DSGVO-01 |
| PRV-014 | Rectification: master data edited normally; the response template explains that issued documents remain unchanged (GoBD) and offers a Rechnungsberichtigung where an issued invoice is wrong (EC-081) | MUST | P3 | DSGVO-02, UST-31 |
| PRV-015 | Art. 30 record of processing (DSGVO-01) template maintained in the Verfahrensdokumentation annex and used for Art. 15 information | MUST | P1 | DSGVO-01 |
| PRV-016 | External services list with role, data categories, region, AVV/terms confirmation date and documentation link; non-EU endpoints warn (DSGVO-04, AO-06). Shipped entries: **Enable Banking** (licensed PSD2 AISP, bank account data, P2), **Cloudflare** (Email Sending: auth mail and owner notifications; R2: backups, checkpoints, receipt inbox; Email Routing + Worker: e-mail-in; DNS for `BASE_DOMAIN`), **Tailscale** (network coordination; device/user metadata only, payload end-to-end encrypted), Anthropic Claude OCR (opt-in), ntfy (if used), eVatR/VIES (VAT-ID checks), Let's Encrypt (certificate issuance, hostnames only). Printed in the Verfahrensdokumentation chapter 15 and the Art. 30 annex | MUST | P1 | DSGVO-04, AO-06 |

### 3.3 Notifications (NTF)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| NTF-001 | `notifications` with kind, severity (`info`/`warning`/`error`/`critical`), title, body, link, entity ref, `dedupeKey` (kind + entity + day), created/read timestamps; in-app bell with unread count, list with filters, „Alle als gelesen markieren"; retention of read notifications 90 days (not GoBD-relevant) | MUST | P1 | — |
| NTF-002 | Kinds catalog (§4.8) with default severity and channels; per-kind channel matrix editable in `/einstellungen/benachrichtigungen`; `critical` kinds cannot be disabled for in-app and e-mail | MUST | P1 | SEC-04 |
| NTF-003 | E-mail channel: via Cloudflare Email Sending (02 §9) to the owner's notification address (setting), plain subject „[{Firma}] {Titel}", link to `app.<BASE_DOMAIN>` (opens only inside the tailnet); data-minimal body like NTF-004; failures don't block in-app delivery | MUST | P1 | — |
| NTF-004 | ntfy channel: server URL (self-hosted recommended; ntfy.sh listed as an external service with DSGVO-04 warning), topic, optional access token (encrypted), priority mapping (critical = 5, error = 4, warning = 3); **data-minimal payloads** by default (no customer names or amounts; e.g. „Angebot angenommen – Details in der App"), option „Details senden" | MUST | P1 | DSGVO-04, DSGVO-05 |
| NTF-005 | Daily digest e-mail at 08:00 (Europe/Berlin) for `info`/`warning` kinds when „Zusammenfassung" is chosen; quiet hours for ntfy (default 22:00–07:00) except `critical` | SHOULD | P1 | — |
| NTF-006 | Deduplication: the same `dedupeKey` within its window updates the existing notification (counter) instead of creating a new one; escalation: an unresolved `error` older than 24 h is re-sent once | MUST | P1 | — |
| NTF-007 | Notifications are generated by domain events and crons (02 §7 `deadlines.notify`, `integrity.verify`, `retention.scan`, backups check), never by UI-only code, so API/MCP-triggered events notify too | MUST | P1 | — |

## 4. Workflows and state machines

### 4.1 Audit action taxonomy (excerpt; the full list lives in `src/domain/audit/actions.ts` and is part of the mutation inventory)

`document.create_draft | update_draft | delete_draft | finalize | artifacts_ready | artifacts_blocked | export | mark_sent | mark_sent_retracted | cancel | correct | accept | reject | withdraw | download_original | convert | revise | supersede | reopen | expire | mark_received | progress` (the last seven added by the F04 quotes/conversions slice: conversion or collective invoice, „Neue Version“, the replaced quote version, „Wieder öffnen“, expiry by `deadlines.notify`, „Erhalten“, recomputed chain progress) · `payment.record | reverse | receipt_print` · `voucher.create | update | finalize | replace_file | cancel` · `bank.connect | consent_renew | disconnect | import | sync | match | unmatch | mark | unmark | revision | statement_pdf | duplicate_resolve | reversal_link | rollback` (the last six added by the F07 P1 statement-import slice: „Markierung aufheben“, raw revision rows, PDF attached later, possible-duplicate decision, BNK-121 link, BNK-036 rollback) · `cash.transfer | transfer_reverse` · `journal.post | reverse | manual | opening_balance` · `period.lock` · `tax_filing.submit | correct | sondervorauszahlung` · `asset.create | depreciate | dispose` · `contact.* | product.* | project.* | time_entry.*` · `settings.<section>.update` · `rule_override.add` · `api_key.create | revoke` · `webhook.endpoint.*` · `auth.sign_in | sign_out | passkey_add | passkey_remove | totp_enable | totp_disable | otp_mail_failed` · `member.create | role_change | extend | expire | disable | revoke_sessions` („Sitzungen abmelden“, 04 §4.10) · `invite.create | resend | revoke | accept` · (`portal.token.*` reserved, F10 deferred) · `export.datev | gdpdu | full | csv` · `import.create | files | mapping | resolutions | preview | commit | discard | finish | fail | record | preset | protocol` · `integrity.run | checkpoint | acknowledge` · `security.write_rejected | access_denied` · `auditor.access` · `dsgvo.request.* | restrict | export` · `retention.purge | anchor` · `system.startup | migration | restore | restore_drill`.

### 4.2 Audit write (inside every mutation)

```
customMutation wrapper
  ├─ actor from JWT (user: session + member + role/expiry/TOTP → role auditor/viewer writes rejected | api-key | mcp: scopes) or internal system job
  ├─ handler runs; model layer writes via withTriggers(ctx).db
  │     trigger: immutability check (AUD-010) → abort on violation
  │     trigger: collect diff for audit
  ├─ audit.append(entries): read head (by_seq desc) → seq+1, prevHash = head.hash, hash = sha256(prevHash ‖ JCS(entry))
  └─ assert writes > 0 ⇒ audit entries > 0 (else throw audit_missing)
```

### 4.3 Integrity run

```
02:00 integrity.verify
  chain: from lastVerifiedSeq (Sunday: from anchor/genesis) → recompute hashes → first mismatch = finding
  checkpoint: latest JWS signature ok? chain contains its lastSeq/lastHash? R2 copy identical?
  artifacts / snapshots: re-hash (incremental + sample; monthly full)
  invariants: RI-01…RI-28
  counts: append-only tables ≥ previous checkpoint counts
  → integrityRuns { ok, findings[] } → if ERROR: banner + e-mail + ntfy + webhook + finalisation blocked until acknowledged
02:30 integrity.checkpoint → JWS → integrityCheckpoints + R2 checkpoint bucket (bucket lock recommended) (+ e-mail)
```

### 4.4 Auditor member lifecycle

```
invite(email, role auditor, years, expiresAt ≤ 30 d, Aktenzeichen) ─▶ invited ─(e-mail code sign-in from a tailnet device)─▶ active
active ─▶ expired (expiresAt; members.expire revokes sessions) | disabled (owner) | extended (owner, reason, ≤ 30 d more)
first sign-in → notification; each request → auditor.access
expiry mid-session → next request: sign-in page with „Ihr Prüferzugang ist abgelaufen."
```

### 4.5 DSGVO request

```
open ──start──▶ in_progress ──complete(result artifact)──▶ done
  │                │──extend(reason, notice sent) ──▶ extended ──complete──▶ done
  └──reject(reason Art. 12(5) / identity not verified)──▶ rejected
erasure: preview buckets → execute (delete now, restrict, schedule) → done with confirmation letter
scheduled purge date reached → appears in the purge worklist (still manual, PRV-005)
```

### 4.6 Verfahrensdokumentation chapters

| # | Chapter | Auto-filled from | Owner must complete |
|---|---|---|---|
| 1 | Allgemeine Beschreibung (Unternehmen, Tätigkeit, Organisation, Verantwortliche) | company profile (+ versions), legal form, tax data, method, chart | business description, responsibilities, Steuerberater (if any), deputy |
| 2 | Eingesetzte Hard- und Software | app version, Convex/Next/sidecar versions, hosting (own server "Proxmox PVE", Dokploy fork), server location (AO-06), network (tailnet, Caddy edge) | hardware/devices used by the owner |
| 3 | Zugriffskonzept (SEC-07) | login (passkey, e-mail code, optional TOTP), members and roles with validity, tailnet-only hosts and grants, security checks (AUD-020), API keys (names/scopes), MCP keys, auditor procedure (02 §4) | physical access to devices, who knows secrets, credential custody |
| 4 | Belegeingang, ersetzendes Scannen (GOBD-08) | inbox channels, hashing at capture, OCR settings, E-Rechnung validation | scanning procedure (who, when, quality check, paper disposal) — template provided |
| 5 | Ausgangsrechnungen | lifecycle, number ranges (formats), ER-03 rules, layouts (versions), dispatch (download + send log; no e-mail from the app) | special agreements (consent handling, paper invoices) |
| 6 | Zahlungsverkehr und **Bankdaten** | section „Bankdaten" (F07 BNK-116): provider Enable Banking (licensed PSD2 AISP, restricted mode), application ID, consent periods and history, 6-hourly sync with the ≤ 4 unattended fetches rule, status of the written confirmation/price request; fallback statement imports (CAMT.053/MT940/CSV + monthly signed PDF, continuity checks); matching rules; payment sources (bank, cash, private) | manual payment handling |
| 7 | Kasse | one cash account without a cash book (F07 CSH-020…030): cash only with invoices/vouchers, never-negative rule, transfers with Eigenbeleg, cash report; or the statement „keine Bargeschäfte"; AO-04 statement „kein Kassensystem" | cash handling, counting procedure |
| 8 | Buchführung | posting matrix version (F08), role mapping (with confirmation dates), period lock practice, manual entries policy | monthly closing routine |
| 9 | Anlagenbuchhaltung | AfA rule versions, GWG/Sammelposten choices per year | inventory procedure |
| 10 | Steuern | UStVA/ZM periods, manual submission flow, lock on submission | who submits (owner; Steuerberater only if one is engaged) |
| 11 | Schnittstellen und **Datenmigration** | REST/MCP/outbound webhooks, DATEV format version + acceptance record (if used); section „Datenmigration" (F09 IMP-024): source system and date, uploaded sevdesk export files with SHA-256, import protocol PDF (mapping, counts, deviations, number-range decisions, actor), Buchungsbeginn, statement that historical documents are read-only archive records with their original PDF | where the old system's data is kept and for how long |
| 12 | Archivierung und Aufbewahrung | formats (PDF/A-3, XML), hashing, retention classes, purge procedure | — |
| 13 | Datensicherung und Wiederherstellung | backup schedule/retention to R2 (08 §7), checkpoint bucket lock (if configured), last restore drills | restore responsibility |
| 14 | Internes Kontrollsystem | integrity checks, checkpoints (public key fingerprint), invariants, notifications | review routine |
| 15 | Datenschutz | external services and processors (PRV-016: Enable Banking, Cloudflare Email/R2/Email Routing/DNS, Tailscale, optional Claude OCR, ntfy, eVatR/VIES, Let's Encrypt) with role, data, region and AVV date; Art. 30 record (annex); DSGVO procedures | DSB contact if any |
| 16 | Änderungshistorie | release notes, settings changes from the audit log, previous versions | — |
| Annex | Buchungsregeln (posting matrix), Art. 30 Verzeichnis, Scan-Arbeitsanweisung, Prüferzugang-Anleitung | generated | sign-off |

### 4.7 Retention classes (rule table `retention-2026.1`, GOBD-20)

| Record type | Class | Years | Trigger year |
|---|---|---|---|
| Journal, ledger accounts, periods, opening balances, assets/AfA, tax filings, Verfahrensdokumentation versions, audit log, integrity checkpoints, VAT-ID check evidence (MISC-04) | books10 | 10 | entry date / filing period / version superseded / entry `at` |
| Invoices of all types, corrections, Storno, self-billing, vouchers + files, bank transactions + statements, cash entries/closings, payments, provider statements, timesheets of billed time, acceptance PDFs attached to invoices | vouchers8 | 8 | document/booking date |
| Quotes, order confirmations, reminders, business correspondence (send log `.eml`), SEPA mandates (after last use), portal acceptance evidence for quotes | letters6 | 6 | document date / last use |
| Delivery notes that are not Buchungsbelege ⚠ | letters6 (default) | 6 | document date |
| OSS records (P4) | books10 | 10 | period |
| Drafts, notifications, technical logs, portal view logs, unbilled time entries | none | — | deletable (drafts: audited) |

### 4.8 Notification kinds (default severity · channels)

| Kind | Severity | Channels |
|---|---|---|
| `integrity.failed`, `checkpoint.upload_failed` (2×), `access.misconfigured`, `clock.skew_critical` | critical | in-app, e-mail, ntfy |
| `backup.stale`, `restore_drill.overdue`, `einvoice_tools.down`, `artifact.blocked`, `auth_mail.failed`, `bank.reauth_required` | error | in-app, e-mail, ntfy |
| `deadline.ustva`, `deadline.zm`, `deadline.14a`, `deadline.vorauszahlung`, `dsgvo.deadline`, `uninvoiced.150d` | warning | in-app, digest, ntfy (due − 1 day) |
| `threshold.ku`, `threshold.800k`, `threshold.oss`, `project.budget`, `rules.stale`, `api_key.expiring`, `bank.consent_expiring`, `member.expiring`, `cert.expiring`, `verfahrensdoku.outdated`, `retention.purge_eligible`, `period.unlocked_old` | warning | in-app, digest |
| `quote.accepted`, `quote.declined`, `invoice.paid`, `payment.received`, `inbox.new`, `inbox.needs_review`, `export.ready`, `import.finished`, `auditor.first_access`, `member.joined` | info | in-app (+ ntfy for accepted/paid optional) |

## 5. Validation rules and edge cases (exhaustive; exact German error/warning messages)

### 5.1 Audit, integrity, clock, restore

| # | Case | Behaviour | Message (DE) |
|---|---|---|---|
| E-AUD-01 | A write without an audit entry (programming error) | Transaction aborted `audit_missing`; CI catches via inventory | „Interner Fehler: Änderung ohne Protokolleintrag abgelehnt." |
| E-AUD-02 | Attempt to update/delete an audit entry (any path through the app) | `immutable_record`, logged `security.write_rejected` | „Protokolleinträge sind unveränderlich." |
| E-AUD-03 | Out-of-band edit via Convex dashboard/admin key (bypasses triggers) | Detected at the next integrity run (hash mismatch, snapshot mismatch or count decrease) → ERROR, finalisation blocked until acknowledged (EC-182) | Banner „Integritätsprüfung fehlgeschlagen: {entität} (seq {n}). Neue Rechnungen sind bis zur Bestätigung gesperrt." |
| E-AUD-04 | Chain gap (missing `seq`) | Finding with the gap range | „Lücke in der Protokollkette zwischen seq {a} und {b}." |
| E-AUD-05 | Chain hash mismatch | Finding with the first broken `seq` and entity | „Protokolleintrag seq {n} wurde verändert oder beschädigt." |
| E-AUD-06 | Checkpoint signature invalid or the R2 copy differs from the local one | Critical finding | „Prüfpunkt vom {datum} ist ungültig oder weicht von der externen Kopie ab." |
| E-AUD-07 | Head behind the latest checkpoint (data loss/restore) | Critical finding with missing range (EC-183) | „Der aktuelle Datenstand endet vor dem Prüfpunkt vom {datum} (seq {a} < {b}). Daten seit {zeit} fehlen." |
| E-AUD-08 | Artifact re-hash mismatch | Critical finding | „Archivdatei {datei} ({beleg}) stimmt nicht mehr mit dem gespeicherten Hash überein." |
| E-AUD-09 | Append-only table count decreased vs checkpoint | Critical finding | „In {tabelle} fehlen {n} Datensätze gegenüber dem Prüfpunkt vom {datum}." |
| E-AUD-10 | Checkpoint upload fails | Retry hourly; after 2 failures notification | „Prüfpunkt konnte nicht extern gespeichert werden ({fehler})." |
| E-AUD-11 | Clock skew > 2 s | Warning banner (GOBD-22) | „Die Serverzeit weicht um {s} s ab. Bitte Zeitsynchronisation (NTP) prüfen." |
| E-AUD-12 | Clock skew > 60 s | Finalisation and date-assigning actions refused (EC-027) | „Fertigstellen gesperrt: Die Serverzeit weicht um {s} s ab." |
| E-AUD-13 | NTP unreachable | Compare web vs Convex only; warning after 1 h without NTP | „Zeitquelle nicht erreichbar – Abweichung kann nicht geprüft werden." |
| E-AUD-14 | Restore from backup into production | `system.restore` entry after the restored head records the backup timestamp and the gap to the latest checkpoint; purge replay runs (PRV-009); E-AUD-07 shown until the owner documents re-entry | „Wiederherstellung durchgeführt. Daten zwischen {a} und {b} müssen nacherfasst werden." |
| E-AUD-15 | Restore drill: head ≠ production checkpoint for the same timestamp | Drill recorded as failed; error notification | „Wiederherstellungstest fehlgeschlagen: Prüfkette stimmt nicht überein." |
| E-AUD-16 | Acknowledging an integrity failure without a note | Blocked | „Bitte beschreiben Sie Ursache und Maßnahmen." |
| E-AUD-17 | Migration changes protected content (RI-01/04/14 differ before/after) | Migration aborted (EC-184) | „Migration {name} abgebrochen: geschützte Inhalte würden verändert." |
| E-AUD-18 | Very high audit write contention (bulk import) | Batches of ≤ 100 records per mutation; OCC retries; import resumable | — |

### 5.2 Login, access and security

| # | Case | Behaviour | Message (DE) |
|---|---|---|---|
| E-AUD-20 | Production start without required secrets (`APP_ENCRYPTION_KEY`, `JWT_PRIVATE_KEY_PEM` in web; `BETTER_AUTH_SECRET`, `JWKS`, `OWNER_EMAIL` in Convex) | `web` exits / auth functions refuse | (log) „{variable} fehlt – Start im Produktivmodus verweigert (SEC-01)." |
| E-AUD-21 | Request without session on `app.` (or session expired/revoked, member expired/disabled) | Redirect to `/anmelden` (pages) / 401 (Server Actions, Convex) — fails closed (EC-185) | „Bitte melden Sie sich an." / modal „Sitzung abgelaufen" (04 §4.9) |
| E-AUD-22 | `api.` self-test returns 200 for an admin path, or port 8443 serves more than `/api/v1` | Critical finding | „Admin-Seiten sind über {api-host} erreichbar. Sofort Proxy-Konfiguration prüfen." |
| E-AUD-23 | `BETTER_AUTH_SECRET` or `JWKS` older than 12 months | Warning | „Die Anmelde-Schlüssel sind älter als 12 Monate. Bitte erneuern (alle Sitzungen werden beendet)." |
| E-AUD-24 | Non-EU endpoint configured (R2 jurisdiction, LLM, ntfy) without AVV | Warning; setup completion blocked for a checkpoint bucket outside the EU (AO-06) | „{dienst} verarbeitet Daten außerhalb der EU. Auftragsverarbeitungsvertrag und § 146 Abs. 2 AO beachten." |
| E-AUD-25 | API key leaked → revoked (EC-186) | Revocation effective ≤ 10 s; audit preset „API-Schlüssel {name}" shows all its actions | Info |
| E-AUD-26 | Sign-up attempt with an e-mail that is neither `OWNER_EMAIL` (bootstrap) nor invited | No user is created; audited `security.access_denied` (no e-mail value in clear, hash only) | „Für diese E-Mail-Adresse besteht keine Einladung." (bootstrap: „Die Ersteinrichtung ist nur mit der hinterlegten Inhaber-Adresse möglich.") |
| E-AUD-27 | Too many code requests for one address | Throttled (5/hour, 20/day per address) | „Zu viele Codes angefordert — bitte in {n} Minuten erneut versuchen." |
| E-AUD-28 | ⚠ action with a session older than 10 min | Re-authentication required (passkey or new code) before the action runs | „Zur Bestätigung bitte erneut mit Passkey bestätigen." |
| E-AUD-29 | Role lacks permission (e.g. bookkeeper opens settings write, viewer finalises) | 403 `forbidden_role`, `security.write_rejected` | „Ihre Rolle ({rolle}) erlaubt diese Aktion nicht." |
| E-AUD-30a | Member with TOTP signs in by e-mail code and skips the TOTP step | Every request except `/anmelden/zwei-faktor` rejected (`totp_required`) | „Bitte geben Sie den Code aus Ihrer Authenticator-App ein." |
| E-AUD-30b | Wildcard certificate expires in < 14 days or `app.` no longer resolves to the Caddy service | Error notification `cert.expiring` / `access.misconfigured` | „Das Zertifikat für *.{BASE_DOMAIN} läuft am {datum} ab." / „{host} zeigt nicht mehr auf den Tailnet-Dienst. DNS aktualisieren (Runbook)." |

### 5.3 Auditor access

| # | Case | Behaviour | Message (DE) |
|---|---|---|---|
| E-AUD-30 | Auditor member expired | Sessions revoked; sign-in refused, no data | „Ihr Prüferzugang ist am {datum} abgelaufen. Bitte wenden Sie sich an {Firma}." |
| E-AUD-31 | Auditor deactivated during a session | Next request 401 | same text with „beendet" |
| E-AUD-32 | Auditor attempts any write (UI action, API call, Server Action, Convex mutation) | 403, `security.write_rejected` | „Nur Lesezugriff." |
| E-AUD-33 | Auditor opens data outside the granted years | 403 / filtered out | „Dieser Zeitraum ist nicht freigegeben." |
| E-AUD-34 | Auditor validity longer than 30 days requested | Blocked; extension allowed after expiry review | „Ein Prüferzugang ist höchstens 30 Tage gültig. Bitte verlängern Sie bei Bedarf." |
| E-AUD-35 | Auditor's device not in the tailnet | The app is unreachable for them (no public host); the invite dialog explains the on-site/tailnet options | (dialog) „Der Prüfer benötigt ein Gerät im Tailnet (vor Ort oder per Tailnet-Einladung)." |
| E-AUD-36 | Auditor shares their sign-in | Not technically preventable; every access is logged with the session; the owner can end sessions | — |

### 5.4 Retention, purge, DSGVO

| # | Case | Behaviour | Message (DE) |
|---|---|---|---|
| E-PRV-01 | Purge attempt before `retentionUntil` (e.g. 2019 invoice in 2026) | Refused (RI-20) | „{beleg} ist bis {datum} aufbewahrungspflichtig und kann nicht gelöscht werden." |
| E-PRV-02 | Purge while Betriebsprüfung-Modus active (EC-181) | Refused | „Während einer Betriebsprüfung sind Löschungen gesperrt." |
| E-PRV-03 | Ablaufhemmung checklist not fully confirmed | Refused | „Bitte bestätigen Sie alle Punkte zur Ablaufhemmung (§ 147 Abs. 3 Satz 5 AO)." |
| E-PRV-04 | Confirmation phrase wrong | Refused | „Bitte geben Sie „ENDGÜLTIG LÖSCHEN" ein." |
| E-PRV-05 | Purge requested via API/MCP | 403 (never grantable, 05-api §2) | — |
| E-PRV-06 | Purging documents whose journal entries are still retained | Documents purged with tombstones; journal stays; Belegfeld text kept; contact link kept until the contact can be anonymised (PRV-007) | Info |
| E-PRV-07 | Audit prefix purge would cut through non-expired entries | Prefix stops at the first non-expired entry | — |
| E-PRV-08 | Restore of a backup older than a purge | Purge replay re-applies tombstones; report lists re-purged records | „{n} bereits gelöschte Datensätze aus der Sicherung wurden erneut gelöscht." |
| E-PRV-09 | Erasure request for a customer with retained invoices (EC-180) | Bucket preview; delete now / restrict / schedule; letter explains retention (Art. 17 Abs. 3 lit. b) | „Rechnungen müssen bis {datum} aufbewahrt werden. Die Daten wurden gesperrt und werden danach gelöscht." |
| E-PRV-10 | Erasure request for a contact with open receivables | Restrict; dunning allowed with warning (legal claims) | Owner: „Offene Forderungen ({betrag} €) dürfen weiter verfolgt werden (Art. 18 Abs. 2 DSGVO)." |
| E-PRV-11 | Creating a document for a restricted contact | Blocked | „Kontakt ist gesperrt (DSGVO Art. 18) und kann nicht verwendet werden." |
| E-PRV-12 | Request not answered by `dueAt` | Error notification; register shows overdue | „DSGVO-Anfrage von {name} ist seit {datum} überfällig." |
| E-PRV-13 | Extension without notice date | Blocked | „Bitte Datum der Mitteilung an die betroffene Person angeben (Art. 12 Abs. 3 DSGVO)." |
| E-PRV-14 | Received 31.01. → due date | 28.02. (or 29.02.); if Saturday/Sunday/holiday → next working day | — |
| E-PRV-15 | Identity not verified | Completion blocked unless rejected with reason | „Identität der anfragenden Person ist nicht bestätigt." |
| E-PRV-16 | Data subject not a contact (e.g. contact person in a supplier e-mail) | Free subject; search by e-mail across contacts, channels, inbox items, send logs | — |
| E-PRV-17 | Access export includes other persons' data (e.g. CC addresses) | Third-party e-mail addresses masked in the export | — |
| E-PRV-18 | Deletion request for a prospect without any documents | Hard delete of the contact (audited with a hash, not content) | — |

### 5.5 Verfahrensdokumentation, notifications, backups

| # | Case | Behaviour | Message (DE) |
|---|---|---|---|
| E-AUD-40 | Release with missing owner inputs | Blocked, chapter list highlights gaps | „Für die Freigabe fehlen Angaben in Kapitel {n}: {feld}." |
| E-AUD-41 | Relevant setting changed after release | Version marked outdated + notification | „Verfahrensdokumentation muss aktualisiert werden: {änderung}." |
| E-AUD-42 | Old version requested | Delivered unchanged (PDF/A + hash) | — |
| E-AUD-43 | Backup object older than threshold | Warning/error per AUD-026 | „Letzte Datenbanksicherung vor {stunden} Stunden." |
| E-AUD-44 | R2 read-only credentials missing | Backup status „unbekannt" warning | „Sicherungsstatus kann nicht geprüft werden (R2-Lesezugang fehlt)." |
| E-AUD-45 | No bucket-lock rule on the checkpoint bucket | Warning (recommended, not required) | „Für den Prüfpunkt-Bucket ist keine Aufbewahrungssperre eingerichtet (empfohlen)." |
| E-NTF-01 | ntfy server unreachable | In-app/e-mail unaffected; warning after 3 failures | „ntfy-Benachrichtigungen konnten nicht zugestellt werden." |
| E-NTF-02 | Attempt to disable a critical kind for e-mail | Blocked | „Kritische Meldungen können nicht abbestellt werden." |
| E-NTF-03 | Same event repeated (e.g. backup stale every hour) | Deduplicated, counter increments | — |

## 6. UI

| Route | Content |
|---|---|
| `/einstellungen/audit` | Audit viewer (AUD-006): filter bar, preset chips („Claude heute", …), virtualised timeline, diff drawer, chain status badge, export |
| Detail pages „Verlauf" tab | Entity timeline with actor badges (04-ui-ux §4.2) |
| `/einstellungen/system/integritaet` | Last runs (ok/findings), current chain head, latest checkpoint (date, seq, R2 status, signature ✓), „Prüfpunkt verifizieren" upload, acknowledge dialog |
| `/einstellungen/system/sicherheit` | Setup checks list (AUD-020) with traffic lights and remedies; access concept (login + tailnet); secret ages; certificate expiry; clock skew |
| `/einstellungen/system/backups` | Backup objects table (R2), checkpoint bucket-lock status, restore-drill log + „Test dokumentieren" form, link to the runbook |
| `/einstellungen/mitglieder` (tab „Prüfer") | Auditor members (invite with years, validity ≤ 30 days, Aktenzeichen), active/expired list, access log per auditor, extend, deactivate (04 §4.10) |
| Auditor UI | Same layout with a persistent banner „Prüferzugang (nur Lesen) · gültig bis {datum} · Zeitraum {jahre}"; all action buttons hidden; downloads allowed |
| `/einstellungen/verfahrensdokumentation` | Chapter list with status, editor per chapter (auto sections read-only preview + owner forms), „Vorschau (PDF)", „Freigeben", versions list with downloads and diff |
| `/einstellungen/datenschutz` | Tabs: Anfragen (register with due dates, overdue red), Externe Dienste (AVV), Aufbewahrung (classes, purge worklist, Betriebsprüfung-Modus), Löschläufe (history) |
| Contact detail ⋯ | „DSGVO: Auskunft", „DSGVO: Löschung/Sperrung" (opens the request flow) |
| Bell / `/benachrichtigungen` | Notification list (filters severity/kind), mark read; `/einstellungen/benachrichtigungen` channel matrix, e-mail address, ntfy settings with „Test senden" |
| Global banner | Integrity ERROR, access misconfiguration, clock skew > 60 s, overdue backups (critical/error only) |

Mobile: audit viewer as cards with expandable diffs; settings pages as stacked lists; banners stay visible.

## 7. API and MCP exposure

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/audit-log` (`actor`, `actor_type`, `channel`, `entity_type`, `entity_id`, `action`, `from`, `to`, `q`) | audit:read | Cursor pagination by `seq`; includes `hash`/`prev_hash` |
| GET | `/audit-log/verify?from_seq=&to_seq=` | audit:read | Server-side recomputation result for a segment |
| GET | `/integrity/runs`, `/integrity/checkpoints` | audit:read | Latest results, JWS strings |
| GET | `/notifications`, POST `/notifications/{id}/read` | settings:read / settings:write | |
| GET | `/dsgvo-requests` | settings:read | Register read-only via API (no execution of erasure/purge via API) |
| — | Members/invites (incl. auditors), purge, Betriebsprüfung-Modus, Verfahrensdokumentation release, access settings | none | UI only (never grantable, 05-api §2) |

MCP: `audit_log_search` (readOnlyHint, scope `audit:read`): `{ actor_type?, actor?, since?, until?, entity?, action?, preset?: "claude_today" }` → concise list with diffs summarised; `workspace_overview` includes integrity/backup status flags. No MCP tools for purges, DSGVO execution, members/auditors or settings in this file (EC-188/189: MCP cannot weaken controls).

Webhooks: `integrity.check_failed` (05-api §5.3); proposed `api_key.revoked`, `dsgvo.request_overdue`, `backup.stale`.

## 8. Acceptance tests

| Test ID | Given / When / Then | Type | Covers req IDs |
|---|---|---|---|
| TST-AUD-01 | Every public/internal mutation in the inventory / when it writes / then ≥ 1 audit entry exists in the same transaction; a test mutation writing without audit throws `audit_missing` | C | AUD-001, AUD-012, RI-15 |
| TST-AUD-02 | Audit entries via UI, API key „website", MCP key „Claude" and cron / then actor, key name, MCP client, channel, truncated IP, UA, requestId recorded | C | AUD-002, SEC-02 |
| TST-AUD-03 | Update containing an encrypted secret / then the diff shows „[redacted]" and the hash is computed over the redacted entry | U, C | AUD-003 |
| TST-AUD-04 | 1,000 entries / then recomputing `sha256(prevHash ‖ JCS(entry))` from genesis matches every stored hash; JCS golden vectors (RFC 8785) pass | U, C | AUD-004, GOBD-06 |
| TST-AUD-05 | Parallel mutations (integration, real backend) / then `seq` contiguous, no forks | C (integration) | AUD-004, RI-14 |
| TST-AUD-06 | Mutation-inventory test: each mutation against finalised invoice, line, payment, journal entry, cash entry, audit entry and locked-period voucher / then `immutable_record`/`period_locked` | C | AUD-010, AUD-012, GOBD-06, RI-13 |
| TST-AUD-07 | Lint: `ctx.db.patch` outside `convex/model` / then CI lint error | U | AUD-011 |
| TST-AUD-08 | Tamper (integration): direct DB edit of an audit entry's `diff` / then integrity run reports E-AUD-05 with that `seq`; finalisation blocked until acknowledged with a note | C (integration) | AUD-013, AUD-015, EC-182, RI-14, SEC-04 |
| TST-AUD-09 | Tamper: delete an audit entry / then E-AUD-04 gap and E-AUD-09 count decrease | C (integration) | AUD-013, RI-14 |
| TST-AUD-10 | Tamper: change a finalised invoice total in the DB / then snapshot mismatch finding (RI-04) and artifact still verifying | C (integration) | AUD-013, EC-182 |
| TST-AUD-11 | Tamper: replace an archived PDF in storage / then E-AUD-08 on the next run (new-artifact or monthly full) | C (integration) | AUD-013 |
| TST-AUD-12 | Checkpoint job / then JWS verifies with the public key, contains lastSeq/lastHash/counts, uploaded to the checkpoint bucket (MinIO as S3-API stand-in for R2 in CI); a modified JWS fails verification | C (integration) | AUD-016, AUD-017, SEC-04 |
| TST-AUD-13 | R2 copy differs from local checkpoint / then E-AUD-06 critical | C | AUD-013 |
| TST-AUD-14 | Restore drill on staging: restore latest dump / then integrity green and chain head equals the production checkpoint of that time; drill logged | M, C (integration) | AUD-027, SEC-05, GOBD-09 |
| TST-AUD-15 | Restore of a backup older than the latest checkpoint / then E-AUD-07 lists the missing seq range; `system.restore` entry continues the chain from the restored head | C (integration) | AUD-027, EC-183, RI-14 |
| TST-AUD-16 | Clock skew injected 3 s → warning; 61 s → finalisation refused `clock_skew`; back to 0 → allowed | C | AUD-019, EC-027, GOBD-22 |
| TST-AUD-17 | Production boot without `APP_ENCRYPTION_KEY` → exit; Convex auth without `JWKS` → refused; `app.` page without session → redirect `/anmelden`; Server Action / Convex mutation without session → 401; with owner session → 200 | E | AUD-021, SEC-01, EC-185 |
| TST-AUD-18 | Security page: each check fails in a crafted environment (api admin path reachable, 8443 serving UI, cert < 14 days, missing key, non-EU checkpoint bucket, expired member with live session) / then fail state with remedy | E | AUD-020, SEC-01, SEC-06, AO-06 |
| TST-AUD-19 | Viewer preset „Was hat Claude heute geändert?" / then only `mcp` actor entries since 00:00 Europe/Berlin (DST day included) | C, E | AUD-006 |
| TST-AUD-20 | Audit export segment + checkpoint / then external verification script confirms the segment | U | AUD-008 |
| TST-AUD-21 | Auditor member (2024–2025, 14 days) invited, signs in by e-mail code / then read pages work, data from 2023 hidden, Z3 package download works, every request audited, owner notified on first sign-in | E | AUD-022, AUD-023, SEC-03 |
| TST-AUD-22 | Route-table test with an `auditor` and a `viewer` session: every Next route handler, Server Action and public Convex mutation / then 403 for writes | E, C | AUD-023, SEC-03 |
| TST-AUD-23 | Auditor after `expiresAt` / then `members.expire` revoked the sessions and sign-in is refused (E-AUD-30); deactivated mid-session → next request 401 | E | AUD-022, E-AUD-30, E-AUD-31 |
| TST-AUD-24 | Verfahrensdokumentation: release blocked with missing owner fields; after completion → PDF/A version with SHA-256; changing the access concept or a member's role marks it outdated with a diff | C, E | AUD-024, AUD-025, GOBD-10 |
| TST-AUD-25 | Export of the Verfahrensdokumentation / then contains the software change history and the checkpoint public key fingerprint | G | AUD-024, GOBD-10 |
| TST-AUD-26 | Backup status with objects 27 h old → warning; 51 h → error; no bucket-lock rule on the checkpoint bucket → warning | C | AUD-026, SEC-05 |
| TST-AUD-27 | Migration that would rewrite a snapshot / then aborted with E-AUD-17 | C (integration) | AUD-028, EC-184, GOBD-23 |
| TST-AUD-28 | Sign-up gate: no user → only `OWNER_EMAIL` can sign up (becomes `owner`, actor `system:auth`); afterwards an uninvited address creates no user (E-AUD-26); an invited address becomes a member with the invite's role and expiry; the invite is consumed | C | 02 §4.3, SEC-01 |
| TST-AUD-29 | Role matrix: table-driven `canDo(role, action)` for every (role × action) and the same decisions enforced by the Convex wrappers (bookkeeper cannot change settings or members; viewer/auditor cannot write) | U, C | 02 §4.3, E-AUD-29 |
| TST-AUD-30 | Actor format: UI writes are `user:<id>` with `actorRole`; REST `api-key:<id>`; MCP `mcp:<id>`; crons `system:cron.<job>`; the zod schema rejects `owner:owner`, `auditor:x`, `apiKey:x` | U, C | AUD-002, 03 §0.1 |
| TST-AUD-31 | Sessions: e-mail-code sign-in of a TOTP member is `totp_required` until verified; ⚠ action with a 15-min-old session asks for re-authentication; signing out ends Convex access within the token lifetime and writes are refused immediately (`safeGetAuthUser`) | C, E | E-AUD-28, E-AUD-30a |
| TST-AUD-32 | Mutation inventory: a write from `convex/betterAuth/**` to a non-auth table fails CI; sign-in/sign-out produce `auth.sign_in`/`auth.sign_out` audit entries via session triggers | C | AUD-011, AUD-012 |
| TST-PRV-01 | Retention: invoice 2018 → 2026-12-31; journal 2016 → 2026-12-31; quote 2020 → 2026-12-31 (research golden) | U | PRV-001, GOBD-20 |
| TST-PRV-02 | Purge of a 2019 invoice on 2026-10-12 → refused (E-PRV-01); on 2028-01-02 → allowed after checklist + phrase; tombstone and audit entry exist; file deleted | C | PRV-002, PRV-005, PRV-006, GOBD-21, RI-20 |
| TST-PRV-03 | Betriebsprüfung-Modus on / then any purge refused (EC-181) | C | PRV-004, EC-181 |
| TST-PRV-04 | Purge via REST/MCP / then 403 | C | E-PRV-05 |
| TST-PRV-05 | Documents expired (8 y) but journal (10 y) retained / then documents tombstoned, journal intact, contact not anonymised until the journal expires | C | PRV-007 |
| TST-PRV-06 | Audit prefix purge / then signed anchor created and uploaded; verification from the anchor passes; purge never cuts non-expired entries | C | PRV-008, RI-14 |
| TST-PRV-07 | Restore a backup taken before a purge / then purge replay removes the records again (E-PRV-08) | C (integration) | PRV-009, DSGVO-02 |
| TST-PRV-08 | Erasure request for a customer with 2024 invoices (EC-180) / then drafts and notes deleted, contact restricted, portal links revoked, purge due dates per class on the manual worklist (invoices 2033-01-01; journal-linked contact 2035-01-01), letter generated | C, E | PRV-011, PRV-012, DSGVO-02, EC-180 |
| TST-PRV-09 | Restricted contact: new invoice → E-PRV-11; lists/search/MCP hide it; DATEV/GDPdU still include it; dunning allowed with warning | C | PRV-012 |
| TST-PRV-10 | Access export / then ZIP contains all invoices, contact records, audit entries referencing the contact, Art. 15 information; third-party addresses masked | C | PRV-013, DSGVO-03 |
| TST-PRV-11 | Request received 2027-01-31 / then due 2027-02-28 → next working day if weekend; extension requires notice date | U | PRV-010, E-PRV-13, E-PRV-14 |
| TST-PRV-12 | Overdue request / then error notification and red register row | C | PRV-010, E-PRV-12 |
| TST-NTF-01 | Integrity failure / then in-app + e-mail + ntfy (critical priority), cannot be disabled | C | NTF-002, NTF-003, NTF-004 |
| TST-NTF-02 | ntfy payload for `quote.accepted` with minimal mode / then no customer name or amount | U | NTF-004, DSGVO-05 |
| TST-NTF-03 | Same backup-stale event hourly / then one notification with counter; re-sent once after 24 h | C | NTF-006 |
| TST-NTF-04 | Event triggered via MCP (payment recorded) / then notification created | C | NTF-007 |

## 9. Open questions

1. **Auditor access** — *resolved (2026-10-12)*: no token route; the Betriebsprüfer is a time-limited member with role `auditor` (02 §4.3). Remote access needs the auditor's device in the tailnet (UNSURE whether Tailscale device/user sharing works with Tailscale Services; on-site on an owner device is the default).
2. Is the audit log a §147 Abs. 1 Nr. 1 "organisational document" (10 y) — research says "likely"; we use 10 years.
3. Retention of delivery notes that are not Buchungsbelege (BEG III/IV relief) — confirm (6 y default).
4. DSGVO-02 research test expects the purge date 01.01.2033 for 2024 invoices; journal entries referencing the contact keep personal links for 10 years → we stage the purge (documents 2033, contact anonymisation 2035). Confirm with a data-protection advisor.
5. Monthly backups are kept 10 years (08 §7) and contain data purged after 8 years; we rely on purge replay after restore and document this in the Verfahrensdokumentation. Acceptable?
6. Separate `CHECKPOINT_SIGNING_KEY_PEM` vs reusing the JWT key — *resolved*: separate key, added to 02 §4.4 and 08 §5.1 (Convex env).
7. Data model additions (merged into 03; `auditorGrants` since replaced by `members`/`invites`): `verfahrensdokuVersions`, `purgeTombstones`, `purgeBatches`, `chainAnchors`, `restoreDrills`, `clockChecks`, `notificationSettings`, `notifications.dedupeKey/count/entity/severity += critical`, `dsgvoRequests.kind += rectification/objection`, `status += in_progress/extended/rejected`, `subject`, `identityVerified`, `extension`, `auditLog.diffBlob`, `jobs.kind += dsgvo_export/purge/verfahrensdoku_pdf`, `Actor.type` naming (`apiKey` vs `api-key:<keyId>`).
