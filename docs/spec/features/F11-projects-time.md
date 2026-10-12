# F11 — Projects and Time Tracking
> **Status:** v1.0 · 2026-10-12 · **Phases:** P4 · **sevdesk parity:** research 00 §17 (Zeiterfassung add-on: no timer, project = text field), research 09 §4–5; research 02 SHOULD #13, #14 · **Edge cases:** [10-edge-cases.md](../10-edge-cases.md) EC-020, EC-024, EC-026, EC-079 · **Compliance:** UST-01, UST-07, UST-08, UST-15, MISC-03, GOBD-06, GOBD-20, GOBD-22, SEC-02

## 1. Scope (in / out, and what we do better than sevdesk)

**In scope**
- **Projects** with customer, billing mode, rates, budget (hours or amount), status, links to quotes/invoices/vouchers, profitability.
- **Time entries** via a live **timer** (cross-device) and **manual entry**, billable/non-billable, rate resolution, rounding rules.
- **Invoicing unbilled time** into invoice lines (grouping options) with entry locking, supply period derived from the entries, and an optional **timesheet (Leistungsnachweis)** attachment archived with the invoice.
- MCP: "Trag 2h auf Projekt X ein: Workshop-Vorbereitung" (`time_entry_log`) and friends; REST endpoints.
- UST-01 monitoring of unbilled billable time (6-month invoicing deadline).
- Offline time capture in the PWA (queued, synced later; 04-ui-ux §10).

**Out of scope**
- Multi-user teams, approvals, payroll/attendance (Arbeitszeiterfassung under labour law), Gantt/tasks management, resource planning.
- Automatic re-billing of expenses beyond a manual "Auslagen übernehmen" (COULD).

**Better than sevdesk**
- sevdesk: paid add-on, no timer, web-only, "Projekt" only a text grouping, no budgets or profitability (research 00 §17, research 09 §4–5). We provide a timer on all devices, real projects with budgets and margins, rounding rules, timesheets as archived artifacts, and natural-language logging through Claude.

## 2. User stories

| # | As … | I want … | so that … |
|---|---|---|---|
| US-01 | owner | to start a timer on my phone and stop it on my desktop | I capture time where I work |
| US-02 | owner | to log time afterwards with "1:30" or "90m" | I don't lose forgotten hours |
| US-03 | owner | to tell Claude "log 2h on project X: workshop" | logging takes seconds |
| US-04 | owner | to invoice all unbilled time of a project in one click, grouped as I like | billing is fast and complete |
| US-05 | owner | billed entries to be locked | nothing gets billed twice or changed after billing |
| US-06 | owner | budget warnings at 80 % and 100 % | I talk to the customer before overrunning |
| US-07 | owner | to see a project's margin (revenue − expenses − internal time cost) | I know which work pays |
| US-08 | customer | a Leistungsnachweis with the invoice | I can check what I pay for |
| US-09 | owner | a warning if billable time stays unbilled too long | I meet the 6-month invoice deadline |

## 3. Functional requirements

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| PRJ-001 | Projects: number (own number range), name, contact (customer), status `active`/`done`/`archived`, billing mode `hourly`/`fixed`/`non_billable`, hourly rate (`hourlyRateMicros`), internal cost rate (for profitability), budget `{ kind: hours\|amount, value }`, start/end date, default product (service), cost centre, rounding rule, description; projects with entries or documents can only be archived | MUST | P4 | GOBD-02 |
| PRJ-002 | Documents and vouchers (and voucher lines) can reference a project (`projectId`, already in 03); the project page lists quotes, order confirmations, invoices (incl. Storno/corrections), vouchers and time entries | MUST | P4 | GOBD-01 |
| PRJ-003 | **Budget monitoring**: consumption = tracked minutes (hours budget) or billable value of entries + invoiced fixed amounts (amount budget); notifications at 80 % and 100 % (once per threshold per project, re-armed if the budget is raised); budget status shown on project cards, in the timer and in `time_entry_log` results | MUST | P4 | — |
| PRJ-004 | **Profitability**: revenue = Σ net of finalised invoices/corrections/Storno of the project (lines with `projectId` or documents with `projectId`); costs = Σ voucher net with `projectId` (+ non-deductible VAT) + Σ minutes × internal cost rate; margin and margin %; basis selectable: accrual (document date) or cash (payment allocations, F08 §4.4); drill-down to documents/entries | MUST | P4 | GOBD-01 |
| PRJ-005 | **Timer**: start (project/contact/description/product optional at start, required at stop), stop, discard; exactly **one running timer** per instance (single owner) stored server-side (`runningTimer`), live on every device via Convex subscription; starting a new timer stops the running one (confirmation); warning notification after 10 h running; timer UI available in the app header, the mobile bottom drawer („Zeit erfassen") and the command palette | MUST | P4 | GOBD-22 |
| PRJ-006 | Durations are computed from instants (UTC), not wall-clock times, so DST nights are correct; the entry `date` is the Europe/Berlin date of the start instant; a timer crossing midnight stays one entry (option „an Mitternacht teilen") | MUST | P4 | GOBD-22 |
| PRJ-007 | **Manual entry**: date, either start–end time or duration (accepts `1:30`, `1,5`, `1.5h`, `90m`, `2h 15m`), description (required, ≥ 3 chars; generic texts like „Arbeit", „Diverses" get the UST-07 warning because the text flows into the invoice), project and/or contact, product (service), billable flag, rate override | MUST | P4 | UST-07 |
| PRJ-008 | **Rate resolution** at entry creation (stored on the entry as `hourlyRateMicros`, editable while open): entry override → project rate → customer price of the product → product price → default hourly rate (settings); project currency = the contact's currency | MUST | P4 | — |
| PRJ-009 | **Rounding rules** (per project, default from settings): `none`, or increments of 1/5/6/10/15/30/60 minutes with mode `up`/`nearest`; optional minimum per entry (e.g. 15 min); applied **at invoicing** to compute `roundedMinutes` per entry (or per group when "pro Gruppe runden" is chosen); raw durations are never altered; the rule used is stored on the invoice line metadata | MUST | P4 | GOBD-06 |
| PRJ-010 | **Invoice from time entries**: select entries (filters: project, contact, period, billable, open) → grouping `per_entry` (one line per entry: date + description), `per_day`, `per_product_rate` (one line per product/rate with summed hours), `summary` (one line „Leistungen lt. Leistungsnachweis {zeitraum}") → creates a new invoice **draft** or appends to an existing draft of the same contact; lines carry `timeEntryIds`, `unitCode` `HUR` (or `MIN` per settings), product/VAT from the entry's product resolved by supply date (UST-15) | MUST | P4 | UST-07, UST-15 |
| PRJ-011 | Quantity on time lines = Σ rounded minutes / 60, rounded half-up to 3 decimals (`quantityMilli`); line net per EN 16931 rounding; if the minute total is not exactly representable (e.g. 10 min = 0.167 h), the editor shows the exact vs rounded amount and offers the unit `MIN` (quantity = minutes, price per minute with 4 decimals) or a 6-/15-minute rounding rule | MUST | P4 | UST-10 |
| PRJ-012 | **Entry locking**: entries referenced by a draft line → status `in_draft` (not editable, not deletable, not selectable for another invoice); invoice finalised → `invoiced` with `invoicedLineId` and `lockedAt` (immutable, GOBD-06); draft deleted or line removed → back to `open` (audited); Storno of the invoice → entries offered as „wieder abrechenbar" (status `open`, history of previous `invoicedLineIds` kept); Rechnungskorrektur → no automatic change (owner decides per entry) | MUST | P4 | GOBD-06 |
| PRJ-013 | **Supply date** of an invoice created from entries = period `{ from: min(date), to: max(date) }` (single date if one day); the owner can widen it, not narrow it below the entries' range (UST-08); entries spanning a VAT rate change are split into separate lines by sub-period (EC-024) | MUST | P4 | UST-08, UST-15 |
| PRJ-014 | **Timesheet (Leistungsnachweis)**: option per invoice (default from project) to attach a PDF/A table of the billed entries (date, description, duration, rounded duration, optionally rate and amount) with the invoice number and period; rendered at finalisation from the frozen entries, archived as `documentArtifacts.kind = "timesheet_pdf"` with SHA-256 and the invoice's retention; attached to the e-mail and embedded as an additional supporting document in the XRechnung (BG-24) / ZUGFeRD attachment when the profile allows ⚠ | SHOULD | P4 | GOBD-06, ER-01 |
| PRJ-015 | **UST-01 monitor**: billable `open` entries older than 150 days → warning on the dashboard and in `deadlines.notify`; older than 180 days → escalation („Rechnungsfrist überschritten") for B2B/legal-person customers | MUST | P4 | UST-01 |
| PRJ-016 | Non-billable entries are excluded from invoicing selection by default, included in budget (hours) and profitability (time cost) | MUST | P4 | — |
| PRJ-017 | Time reports: hours per project/customer/product/period, billable vs non-billable, unbilled value, utilisation per week; CSV export (F09 EXP-021) | SHOULD | P4 | — |
| PRJ-018 | Offline capture (PWA): manual entries and timer start/stop are queued in IndexedDB and synced; server assigns IDs; conflict rule: if a timer was started on two devices offline, the later start wins and the earlier becomes a manual entry with a „Konflikt" flag | SHOULD | P4 | — |
| PRJ-019 | Retention: entries linked to a finalised invoice get `retentionClass = "vouchers8"` with `retentionUntil` of the invoice; open or non-billable entries have no statutory retention and may be deleted (deletion audited with content) | MUST | P4 | GOBD-20 |
| PRJ-020 | „Auslagen übernehmen": vouchers of the project marked „weiterberechenbar" can be added as invoice lines (net amount, with the configured markup %, own revenue account); the voucher gets `rebilledLineId` | COULD | P4 | — |
| PRJ-021 | All mutations attributed with the canonical actor (`user:<id>`, `api-key:<keyId>`, `mcp:<keyId>`, `system:cron.<job>`, 02 §4.4); entries keep `source: timer \| manual \| mcp \| api \| offline` | MUST | P4 | SEC-02 |

## 4. Workflows and state machines

### 4.1 Time entry

```
            create (manual / timer stop / mcp / api)
                         │
                         ▼
   ┌────────────── open ◀─────────────────────────────┐
   │   edit/delete freely (audited)                    │ draft deleted / line removed
   │                         │ added to invoice draft  │ / Storno → „wieder abrechenbar"
   │                         ▼                         │
   │                     in_draft ─────────────────────┘
   │                         │ invoice finalised
   │                         ▼
   │                     invoiced  (immutable, lockedAt, retention of the invoice)
   │
   └── non-billable entries stay open (never invoiced unless the flag is changed)
```

### 4.2 Timer

```
idle ──start(project?, description?)──▶ running(startedAt) ──stop──▶ idle + time entry (open)
                                           │  └──discard──▶ idle (audited, no entry)
                                           └──start another──▶ confirm → stop current → running(new)
running > 10 h → notification „Timer läuft seit 10 Stunden"
```

### 4.3 Invoice from time entries

```
select entries → choose grouping + rounding preview (raw vs rounded, amounts) → create/append draft
  (single mutation: lines with timeEntryIds; entries → in_draft; audit)
→ owner edits draft (can remove lines → entries back to open)
→ finalise (F04 pipeline) → entries → invoiced; timesheet_pdf rendered from the frozen entries
```

## 5. Validation rules and edge cases (exhaustive; exact German error/warning messages)

| # | Case | Behaviour | Message (DE) |
|---|---|---|---|
| E-PRJ-01 | Start a timer while one is running | Confirm dialog; stops the running one first | „Es läuft bereits ein Timer ({projekt}, {dauer}). Stoppen und neuen Timer starten?" |
| E-PRJ-02 | Stop a timer without description/project or contact | Stop allowed, entry saved as open with „unvollständig" flag; cannot be invoiced until completed | „Bitte Beschreibung und Projekt oder Kunde ergänzen." |
| E-PRJ-03 | Timer running > 10 h / > 24 h | Notification at 10 h; at 24 h the timer auto-stops at 24 h and flags the entry for review | „Timer lief über 24 Stunden und wurde angehalten. Bitte Dauer prüfen." |
| E-PRJ-04 | Manual entry with end before start | Blocked | „Das Ende liegt vor dem Beginn." |
| E-PRJ-05 | Duration 0 or > 24 h for one entry | Blocked | „Die Dauer muss zwischen 1 Minute und 24 Stunden liegen." |
| E-PRJ-06 | Entry date in the future | Blocked | „Zeiten können nicht für die Zukunft erfasst werden." |
| E-PRJ-07 | Overlapping entries | Warning only | „Diese Zeit überschneidet sich mit {n} anderen Einträgen." |
| E-PRJ-08 | Unparseable duration input | Field error | „Dauer nicht erkannt. Beispiele: 1:30, 1,5, 90m, 2h 15m." |
| E-PRJ-09 | Generic description | Warning (UST-07) | „Die Beschreibung ist sehr allgemein und erscheint so auf der Rechnung." |
| E-PRJ-10 | Edit/delete an entry `in_draft` | Blocked | „Dieser Eintrag ist in Rechnungsentwurf {nr/Entwurf} enthalten. Entfernen Sie ihn dort zuerst." |
| E-PRJ-11 | Edit/delete an entry `invoiced` | Blocked | „Dieser Eintrag wurde mit Rechnung {nr} abgerechnet und kann nicht mehr geändert werden." |
| E-PRJ-12 | Entries of different contacts selected for one invoice | Blocked | „Zeiten verschiedener Kunden können nicht in einer Rechnung abgerechnet werden." |
| E-PRJ-13 | Entries with different currencies | Blocked | „Die ausgewählten Zeiten haben unterschiedliche Währungen." |
| E-PRJ-14 | Appending to a draft of another contact | Blocked | as E-PRJ-12 |
| E-PRJ-15 | Entries spanning a VAT rate change (EC-024) | Lines split by sub-period automatically | Info „Wegen Steuersatzänderung am {datum} wurden die Zeiten auf zwei Positionen aufgeteilt." |
| E-PRJ-16 | Entries spanning a KU status change (EC-025) | Split like E-PRJ-15 | Info |
| E-PRJ-17 | Minute total not exactly representable in hours | Warning with exact vs rounded amount; offer `MIN` unit | „{min} Minuten ergeben {h} Stunden (gerundet). Abweichung: {diff} €. Einheit „Minute" verwenden?" |
| E-PRJ-18 | Narrowing the invoice supply period below the entries' dates | Blocked (UST-08) | „Der Leistungszeitraum muss alle abgerechneten Zeiten umfassen ({von}–{bis})." |
| E-PRJ-19 | Project rate changed while open entries exist | Ask whether to update open entries' rates (in_draft/invoiced untouched) | „{n} offene Einträge mit altem Stundensatz aktualisieren?" |
| E-PRJ-20 | Budget 80 % / 100 % reached | Notification; logging still allowed | „Projekt {name}: {80/100} % des Budgets verbraucht ({ist} von {budget})." |
| E-PRJ-21 | Logging via MCP to an archived project | Blocked | „Projekt {name} ist archiviert." |
| E-PRJ-22 | MCP project name ambiguous / not found | Structured error with candidates (max 5) | „Projekt „{eingabe}" ist nicht eindeutig: {liste}. Bitte project_id angeben." |
| E-PRJ-23 | Billable entry without rate (no project/product/default rate) | Blocked at invoicing | „Für {n} Einträge ist kein Stundensatz hinterlegt." |
| E-PRJ-24 | Consumer customer | Unit prices displayed gross on the invoice (MISC-03); net stored | — |
| E-PRJ-25 | Invoice from entries is cancelled (Storno) | Entries offered as „wieder abrechenbar" | „Die Rechnung wurde storniert. {n} Zeiteinträge wieder als abrechenbar markieren?" |
| E-PRJ-26 | Unbilled billable entries > 150 / > 180 days (UST-01, EC-026) | Warning / escalation | „{n} abrechenbare Zeiteinträge sind älter als 150 Tage. Rechnungen müssen spätestens 6 Monate nach der Leistung gestellt werden (§ 14 Abs. 2 UStG)." |
| E-PRJ-27 | DST night: timer 01:30–03:30 wall clock on the last Sunday of October | Duration 3 h (instants) | — |
| E-PRJ-28 | Timer started at 23:50, stopped 00:20 | One entry dated the start day, 30 min (unless split option) | — |
| E-PRJ-29 | Two devices start a timer offline | Later start wins; earlier becomes a manual entry flagged „Konflikt" | „Zeitkonflikt: Ein Timer wurde auf zwei Geräten gestartet." |
| E-PRJ-30 | Archiving a project with open billable entries | Warning | „Es gibt noch {n} nicht abgerechnete Einträge ({wert} €)." |
| E-PRJ-31 | Deleting a project with entries/documents | Blocked → archive | „Projekte mit Zeiten oder Belegen können nur archiviert werden." |
| E-PRJ-32 | Fixed-price project: hourly invoicing attempted | Warning; time is tracked for profitability only | „Festpreisprojekt – Zeiten werden nicht einzeln abgerechnet." |

## 6. UI

| Route / element | Content |
|---|---|
| Header timer (desktop) | Running timer pill (project, elapsed), click → popover (description, project, stop/discard); idle: „▶ Zeit starten" |
| Mobile | Bottom drawer „Zeit erfassen" (from the (+) button): big Start/Stop, project picker, description; recent projects as chips; works offline |
| `/zeiten` | Week view (Mon–Sun columns, totals per day/project) and list view (filters: period, project, contact, billable, status); inline add row; bulk actions „Abrechnen", „Als nicht abrechenbar markieren", „Löschen" (open only); status badges Offen / Im Entwurf / Abgerechnet 🔒 |
| `/projekte` | Cards/list: name, customer, status, budget bar (green < 80 %, amber ≥ 80 %, red ≥ 100 %), unbilled value, margin |
| `/projekte/[id]` | Tabs: Übersicht (budget, KPIs, margin chart), Zeiten, Dokumente, Belege, Einstellungen (rates, rounding, budget, timesheet default); primary action „Zeiten abrechnen" |
| „Zeiten abrechnen" dialog | Entry table with checkboxes, grouping selector, rounding preview (raw vs rounded, amount), target „Neuer Entwurf"/„Zu Entwurf {x} hinzufügen", timesheet toggle |
| Invoice editor | „+ Zeiten übernehmen" (04-ui-ux §4.3) opens the same dialog filtered to the invoice's contact |

## 7. API and MCP exposure

### REST

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/projects` (`status`, `contact_id`, `q`) | projects:read | |
| POST / PATCH | `/projects`, `/projects/{id}` | projects:write | |
| POST | `/projects/{id}/archive` | projects:write | |
| GET | `/projects/{id}/profitability?basis=accrual\|cash` | projects:read | |
| GET | `/time-entries` (`project_id`, `contact_id`, `status`, `billable`, `date_from/to`) | projects:read | |
| POST | `/time-entries` | time:write | `{ date, duration_minutes \| started_at+ended_at, description, project_id?, contact_id?, product_id?, billable?, hourly_rate? }`; `Idempotency-Key` |
| PATCH / DELETE | `/time-entries/{id}` | time:write | open entries only (409 `time_entry_locked`) |
| POST | `/timer/start`, `/timer/stop`, GET `/timer` | time:write / projects:read | |
| POST | `/invoices/from-time-entries` | documents:write | `{ time_entry_ids[], grouping, rounding?, draft_id?, attach_timesheet? }` → draft |

### MCP (06-mcp §3.9)

| Tool | Hints | Scope | Notes |
|---|---|---|---|
| `project_upsert` | — | projects:write | Create/update by ID or exact number |
| `time_entry_log` | — | time:write | `{ project (id, number or name), duration ("2h", "1:30", "90m"), description, date? (default today Europe/Berlin), billable?, product? }` → entry + budget status; ambiguous project → `isError` with candidates (E-PRJ-22) |
| `time_unbilled_list` | readOnlyHint | projects:read | `{ project?, contact?, older_than_days? }` → entries + totals + UST-01 warnings |
| `invoice_from_time_entries` | — | documents:write | Creates a **draft** only; finalising goes through `document_preview` + `document_finalize` (confirm token) |
| Timer tools | not exposed | — | Timer is UI/REST only (MCP logs completed durations) |

Webhooks (proposed): `time_entry.created`, `project.budget_threshold`.

## 8. Acceptance tests

| Test ID | Given / When / Then | Type | Covers req IDs |
|---|---|---|---|
| TST-PRJ-01 | Start timer on device A, stop on device B / then one entry, duration from instants; device A shows idle immediately | E | PRJ-005 |
| TST-PRJ-02 | Timer running, start another / then confirmation; first stopped and saved | C, E | PRJ-005, E-PRJ-01 |
| TST-PRJ-03 | Timer 01:30–03:30 wall clock on DST end day / then 180 min; 23:50–00:20 → one entry dated start day | U | PRJ-006, EC-020, GOBD-22 |
| TST-PRJ-04 | Duration parser: `1:30`, `1,5`, `1.5h`, `90m`, `2h 15m` → 90, 90, 90, 90, 135; `abc` → E-PRJ-08 | U | PRJ-007 |
| TST-PRJ-05 | Rate resolution chain (override, project, customer price, product, default) | U | PRJ-008 |
| TST-PRJ-06 | Rounding 15 min up on entries 7, 16, 31 min / then 15, 30, 45; raw durations unchanged | U | PRJ-009 |
| TST-PRJ-07 | Invoice from 3 entries grouping `per_product_rate` / then one line HUR 1.500 qty, `timeEntryIds` set, entries `in_draft` | C | PRJ-010, PRJ-012 |
| TST-PRJ-08 | 10 min at 90 €/h / then warning E-PRJ-17 with 15.03 vs 15.00; switching to `MIN` yields 15.00 | U | PRJ-011 |
| TST-PRJ-09 | Edit an `in_draft` entry → E-PRJ-10; remove the line from the draft → entry `open` | C | PRJ-012 |
| TST-PRJ-10 | Finalise the invoice / then entries `invoiced`, immutable (mutation inventory includes timeEntries) | C | PRJ-012, GOBD-06 |
| TST-PRJ-11 | Storno of that invoice / then entries offered as „wieder abrechenbar"; history keeps the old line ID | C | PRJ-012, E-PRJ-25 |
| TST-PRJ-12 | Entries 2026-09-03..2026-09-28 / then supply period 03.09.–28.09.2026; narrowing → E-PRJ-18 | U | PRJ-013, UST-08 |
| TST-PRJ-13 | Entries spanning a simulated rate change on 2027-07-01 / then two lines with different rates | U | PRJ-013, EC-024, UST-15 |
| TST-PRJ-14 | Timesheet option / then `timesheet_pdf` artifact archived with SHA-256, content equals the frozen entries; attached to the e-mail; embedded in XRechnung when enabled (KoSIT valid) | G, V | PRJ-014 |
| TST-PRJ-15 | Billable open entry dated 151 days ago / then warning; 181 days → escalation (boundary 150/151, 180/181) | U, C | PRJ-015, UST-01, EC-026 |
| TST-PRJ-16 | Hours budget 10 h, entries reaching 8 h then 10 h / then one notification each | C | PRJ-003 |
| TST-PRJ-17 | Project with invoices 10,000 € net, Storno 1,000 €, vouchers 2,000 €, 40 h × 30 € cost / then margin 5,800 € (58 %) | U | PRJ-004 |
| TST-PRJ-18 | MCP `time_entry_log {project:"Website", duration:"2h", description:"Workshop"}` with two matching projects / then `isError` with candidates; with exact ID → entry created, actor `mcp:<keyId>`, budget status in result | C (MCP contract) | PRJ-021, E-PRJ-22 |
| TST-PRJ-19 | MCP `invoice_from_time_entries` / then only a draft; `document_finalize` without confirm token fails | C | PRJ-010, EC-188 |
| TST-PRJ-20 | Offline: two devices start timers / then conflict rule applied after sync | E | PRJ-018, E-PRJ-29 |
| TST-PRJ-21 | Retention: invoiced entry gets `vouchers8` and the invoice's `retentionUntil`; open entry deletion audited with content | C | PRJ-019, GOBD-20 |
| TST-PRJ-22 | Entries of two contacts selected / then E-PRJ-12 | U | E-PRJ-12 |
| TST-PRJ-23 | Week view and timer drawer on iPhone and desktop / then axe clean, visual baselines | E, V | PRJ-005, PRJ-017 |

## 9. Open questions

1. Embedding the timesheet in XRechnung/ZUGFeRD (BG-24 additional supporting documents) — size limits and whether the customer's systems accept it.
2. Should non-billable time of a fixed-price project count against the hours budget by default? (current: yes)
3. Data model additions (report to lead): `projects.billingMode/internalCostRateMicros/rounding/budgetAlerts/costCenterId/numberRangeId/currency`, `timeEntries.status/lockedAt/roundedMinutes/source/invoicedLineHistory/incomplete/conflict/retentionClass/retentionUntil`, `runningTimer` singleton, `documentArtifacts.kind` += `timesheet_pdf`, `vouchers.rebillable/rebilledLineId`, `numberRanges.docType` += `project`.
