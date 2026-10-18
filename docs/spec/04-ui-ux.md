# 04 — UI / UX Specification

> **Status:** v1.1 · 2026-10-12 (platform update: login pages, members & invites, session expiry, portal routes removed — 02 §4; export/mark-sent dialogs, „Bezahlt mit", Kasse page, bank connection pages, `/steuern/ust-jahr`)
> **Goal:** feature parity with sevdesk's information architecture, but faster, mobile-first where it matters (capturing receipts, checking open invoices, quick quotes on the go), and keyboard-first on desktop. sevdesk's mobile web is not responsive and its app is weak (research 02), so beating it here is an explicit goal.

## 1. Principles

1. **German first.** UI language is German (`de-DE`). English is the second locale (`next-intl`). Legal terms stay German in both locales (Rechnung, Storno, Leistungsdatum, USt-IdNr) and have tooltips.
2. **One primary action per screen**, always visible: a sticky header on desktop, a sticky bottom action bar on mobile.
3. **Irreversible means explicit.** Finalising, sending, Storno, Festschreibung and purge each use a confirm dialog that explains *why* the action cannot be undone (GoBD). No irreversible action happens on a single tap.
4. **Live data.** Lists and detail pages subscribe to Convex queries. Changes made by MCP or the API appear instantly, and a subtle "Aktualisiert durch Claude (MCP)" toast names the actor.
5. **No dead ends.** Every validation error says what is missing and links to the field or setting that fixes it (e.g. "Geschäftsführer fehlt → Einstellungen › Unternehmen").
6. **Numbers are sacred.** Amounts are tabular, right-aligned, and formatted `1.234,56 €`. Input accepts `1234,56`, `1.234,56` and `1234.56` (parsed unambiguously; see §8).

## 2. Technology

| Concern | Choice |
|---|---|
| Components | **shadcn/ui CLI v4** (Base UI primitives, the default since 2026-07), style `new-york`, base color `neutral`, CSS variables |
| Styling | **Tailwind CSS v4.3** (CSS-first config, `@theme inline`, container queries `@container`) |
| Icons | `lucide-react` |
| Tables | TanStack Table v8 + TanStack Virtual (virtualise above 200 rows) |
| Forms | `react-hook-form` + `zod` v4 (schemas shared with Convex validators and the REST API via `src/domain/schemas`) |
| Toasts | `sonner` |
| Theme | `next-themes`: light / dark / system |
| i18n | `next-intl`: `de` (default), `en` |
| Dates | `date-fns` + `de` locale. Business dates are plain `YYYY-MM-DD` strings |
| Charts | Recharts via shadcn `chart`. Follow the `dataviz` skill palette rules |
| PDF preview | Server-rendered PDF in an `<iframe>` (desktop) or full-screen sheet (mobile) |
| Command palette | shadcn `command` (cmdk) |

## 3. Layout and navigation

### 3.1 Breakpoints

| Name | Width | Layout |
|---|---|---|
| `sm` phone | < 768 px | Bottom tab bar + top app bar. The sidebar is a Sheet. Tables become cards. Dialogs become Drawers |
| `md` tablet | 768–1279 px | Sidebar collapsed to icons (`collapsible="icon"`); tables with reduced columns |
| `lg` desktop | ≥ 1280 px | Full sidebar (16 rem); editor in two panes (form + live preview) |

Inside the main content area, use **container queries** (`@container/main`), not viewport queries, because the sidebar changes the available width.

### 3.2 Desktop shell

Modelled on sevdesk's navigation (owner request 2026-10-18: "too many options", compared with the live sevdesk account): a short list of areas, sub-items only for the area you are in, search at the top of the sidebar.

```
┌──────────────────┬──────────────────────────────────────────────────────┐
│ [logo] Firma     │ ⊟                                    [+ Neu ▾] 🔔 ☾ 👤│
│ 🔍 Suchen …   ⌘K │──────────────────────────────────────────────────────│
│ ⌂ Übersicht      │  Breadcrumb › Rechnungen                             │
│ ✉ Aufträge       │  ┌────────────────────────────────────────────────┐  │
│ ▣ Rechnungen     │  │ Rechnungen                  [Rechnung erstellen]│  │
│   │ Wiederkehrend│  │ [Alle][Entwurf][Offen][Überfällig][Bezahlt]…    │  │
│   │ Mahnungen    │  │ 🔍 Suche  Filter▾  Zeitraum▾   Spalten▾ Export▾ │  │
│ ▤ Ausgaben       │  │ ☐ Nr.      Kunde        Datum   Fällig   Betrag │  │
│ ⌂ Bank           │  │ ☐ RE-1042  Müller GmbH  01.10.  15.10. 1.190,00 │  │
│ % Steuern        │  │ …                                               │  │
│ ▥ Auswertungen   │  └────────────────────────────────────────────────┘  │
│ VERWALTEN        │                                                      │
│   Kontakte       │                                                      │
│   Produkte       │                                                      │
│   Einstellungen  │                                                      │
└──────────────────┴──────────────────────────────────────────────────────┘
```

| ID | Requirement | Priority | Phase |
|---|---|---|---|
| NAV-001 | Sidebar areas in this order: Übersicht `/`, Aufträge, Rechnungen, Ausgaben, Bank, Steuern, Auswertungen; then the group „Verwalten“ with Kontakte, Produkte, Einstellungen | MUST | P1 |
| NAV-002 | An area's sub-items are shown only while the area (or one of its pages) is active. An area without its own list links to its first sub-item: Aufträge → Angebote · Auftragsbestätigungen · Lieferscheine; Rechnungen (list) → Wiederkehrend · Mahnungen; Ausgaben (`/belege`) → Posteingang · Anlagen; Bank → Bankkonten · Kasse · Zuordnungen; Steuern → UStVA · EÜR · ZM · USt-Jahr · Rücklage; Auswertungen → Offene Posten · Liquidität · Journal · Kontenplan · Eröffnung · Festschreibung · Export. The area link carries `aria-expanded`, the current page `aria-current="page"` | MUST | P1 |
| NAV-003 | „Suchen … ⌘K“ sits at the top of the sidebar and opens the command palette (§5); the top bar has no second search field on desktop | MUST | P1 |
| NAV-004 | Pages without a sidebar entry stay reachable: Berichte (`/auswertungen`), Zeiten, Projekte (P4) and Benachrichtigungen via the command palette, Mein Konto via the account menu. The palette lists every page once | MUST | P1 |
| NAV-005 | Phone bottom tabs: Übersicht · Rechnungen · Neu · Beleg · Mehr (§3.3); „Mehr“ opens the same sidebar as a sheet | MUST | P1 |

The desktop top bar (sidebar toggle, „+ Neu ▾“, bell, theme, account) stays for now; sevdesk has none (open question to the owner).

### 3.3 Mobile shell

```
┌─────────────────────────────┐
│ ☰  Rechnungen          🔍  │  ← top app bar (title, search icon)
├─────────────────────────────┤
│ [Offen][Überfällig][Alle ▾] │  ← horizontally scrollable status chips
│ ┌─────────────────────────┐ │
│ │ RE-1042        ● Offen  │ │  ← card: number + status
│ │ Müller GmbH             │ │
│ │ fällig 15.10.  1.190,00€│ │
│ └─────────────────────────┘ │
│ …                           │
├─────────────────────────────┤
│ 🏠    🧾    ( + )   📷   ⋯  │  ← bottom tabs: Übersicht · Rechnungen · Neu · Beleg · Mehr
└─────────────────────────────┘
```

- **(+) Neu** opens a bottom drawer: Rechnung, Angebot, Kontakt, Produkt, Zeit erfassen, Beleg.
- **📷 Beleg** opens the camera capture directly (`<input type="file" accept="image/*,application/pdf" capture="environment">`) and uploads to the receipt inbox.
- **⋯ Mehr** opens the full navigation as a Sheet.
- The bottom bar respects `env(safe-area-inset-bottom)`.

### 3.4 Information architecture (routes)

| Section | Route | Notes |
|---|---|---|
| Übersicht | `/` | Dashboard (sevdesk „Übersicht“) |
| Anmelden (no session needed) | `/anmelden`, `/anmelden/code`, `/anmelden/zwei-faktor`, `/anmelden/passkey-einrichten` | Sign-in with passkey (conditional UI) or e-mail OTP, TOTP step, passkey enrolment prompt; first-run owner sign-up uses the same pages (§4.9). `?weiter=<path>` returns to the requested page |
| Mein Konto | `/konto` | Own passkeys (add, rename, remove), TOTP on/off, active sessions (sign out others), e-mail (read-only) |
| Einrichtung | `/einrichtung` (`?schritt=…`) | Setup wizard (owner only); until setup is complete every other route except `/einstellungen/**`, `/kontakte/**`, `/produkte/**`, `/konto` redirects here (F01 SET-001) |
| Angebote | `/angebote`, `/angebote/[id]`, `/angebote/neu` | |
| Auftragsbestätigungen | `/auftraege…` | |
| Lieferscheine | `/lieferscheine…` | |
| Rechnungen | `/rechnungen…` | All invoice types incl. Abschlag, Teil, Schluss, Proforma, Storno, Korrektur; self-billing Gutschriften (P3) as a filter |
| Wiederkehrend | `/rechnungen/wiederkehrend…` | Recurring templates |
| Mahnungen | `/mahnungen` | Dunning cockpit |
| Ausgaben (Belege) | `/belege…`, `/belege/fehlend` | Purchase vouchers, labelled „Ausgaben“ in the navigation like sevdesk; missing-receipt overview (F06 VOU-110) |
| Posteingang | `/posteingang` | Receipt inbox (e-mail, upload, E-Rechnung import) |
| PWA share target | `/share-target` (POST only) | Shared files → receipt inbox (F06 INB-004, P2) |
| Bank | `/bank`, `/bank/[accountId]`, `/bank/zuordnungen` | Accounts, transactions, matching queue (`/bank/lastschriften` returns with F10, deferred) |
| Kasse | `/kasse` | Small cash page: balance, movement list with running balance, „Bargeld eingezahlt / entnommen", cash report (§4.12, F07 §6.7; no cash book, no POS) |
| Kontakte | `/kontakte`, `/kontakte/neu`, `/kontakte/[id]`, `/kontakte/duplikate`, `/kontakte/import` | F02 §6 |
| Produkte | `/produkte`, `/produkte/neu`, `/produkte/[id]`, `/produkte/kategorien`, `/produkte/import` | F03 §6 |
| Zeiten & Projekte | `/zeiten`, `/projekte`, `/projekte/[id]` | P4 (F11) |
| Buchhaltung | `/buchhaltung/journal`, `/buchhaltung/journal/neu`, `/buchhaltung/konten`, `/buchhaltung/eroeffnung`, `/buchhaltung/anlagen`, `/buchhaltung/festschreibung` | F08 §6 |
| Steuern | `/steuern/ustva`, `/steuern/zm`, `/steuern/euer`, `/steuern/ust-jahr`, `/steuern/ruecklage` (each with `/[period]`) | Kennzahlen/Anlage-EÜR sheets with the Mein ELSTER guide and the submission record (Transferticket) per F08; `/steuern/ust-jahr` is the USt-Jahreserklärung worksheet (F08 TAX-023, no submission record) |
| Auswertungen | `/auswertungen`, `/auswertungen/offene-posten`, `/auswertungen/liquiditaet` | Reports; OPOS (F05 PAY-001); cash-flow forecast (F08 RPT-012) |
| Export | `/export` | DATEV, GoBD Z3, full backup |
| Benachrichtigungen | `/benachrichtigungen` | Notification list (bell), F12 |
| Einstellungen | `/einstellungen/{unternehmen,steuern,nummernkreise,layouts,textvorlagen,stammdaten,bank,integrationen,mitglieder,api,webhooks,mcp,import,regeln,benachrichtigungen,audit,datenschutz,verfahrensdokumentation,system}` | Owner only for writes (bookkeepers/viewers/auditors see read-only views where useful, never secrets). Sub-routes: `/einstellungen/nummernkreise/register` (number register + gap report), `/einstellungen/layouts/[id]` (layout editor), `/einstellungen/bank/verbindung` (Enable Banking connection: connect, re-consent, consent expiry; F07), **`/einstellungen/bank/callback`** (Enable Banking redirect URL `https://app.<BASE_DOMAIN>/einstellungen/bank/callback`, HTTPS on the tailnet host, whitelisted in the Enable Banking app; F07), `/einstellungen/mitglieder` (members, roles, invites, auditor access; §4.10), `/einstellungen/system/backups`, `/einstellungen/system/integritaet`, `/einstellungen/system/sicherheit` (F12). The DSGVO tabs of `datenschutz` are P3 (F12). Removed: `email` (no SMTP), `zahlungen`/`portal` (F10 deferred), `pruefer` (auditor = member role) |
| API docs | `https://api.<BASE_DOMAIN>/api/docs` | Scalar (tailnet only, like every host) |

There are **no public routes**: the customer portal `/p/[token]` (F10) and the auditor route `/pruefung/[token]` were removed with the tailnet-only decision (02 §4). A Betriebsprüfer signs in as a time-limited member with role `auditor` (§4.10, F12 AUD-022) and sees the normal UI in read-only mode.

## 4. Page patterns

### 4.1 List page

- **Status tabs** (desktop) or chips (mobile) with counts, e.g. `Offen 12 · Überfällig 3`.
- Search (debounced 200 ms; searches number, customer, amount and text).
- Filters: period (presets: dieser Monat, letzter Monat, Quartal, Jahr, custom), customer, tag, amount range. Filters are persisted in the URL (`?status=overdue&from=…`) so views are shareable and bookmarkable.
- Saved views (P3).
- Columns: configurable; sticky first column; tabular numbers; totals row for amount columns.
- **Bulk actions** (desktop checkbox column; mobile long-press): Exportieren, Als versendet markieren, Mahnen, Als bezahlt markieren, PDF-ZIP, Export CSV, Tag hinzufügen. Bulk operations run as background jobs with a progress toast.
- Cursor pagination (50 per page) plus virtualised scrolling.
- Empty states: an illustration, one sentence, and a primary action ("Erste Rechnung erstellen").
- Row click opens the detail view. On desktop, ⌘-click opens a new tab.

### 4.2 Detail page (document)

```
RE-1042 · Müller GmbH                                 ● Offen  (fällig in 3 Tagen)
[Zahlung buchen] [Exportieren ▾] [Als versendet markieren] [⋯ Mehr: Korrektur, Storno, Mahnung, Duplizieren, PDF, XML]
───────────────────────────────────────────────────────────────────────────────
Tabs:  Übersicht | Zahlungen | Verlauf | Dateien | Verknüpft
Übersicht: rendered document preview (PDF) + key facts sidebar (Betrag, offen, fällig,
           Leistungszeitraum, E-Rechnung-Status ✓ validiert (KoSIT 2026-08), Versand-Log)
Verlauf:   audit timeline (actor badges: Du / member name + role · API "website" · Claude (MCP) · System)
```

### 4.3 Document editor (Angebot, Auftrag, Lieferschein, Rechnung)

**Desktop (≥ 1280):** two panes. The left pane (min 560 px) is the form. The right pane is the live preview, re-rendered (debounced 600 ms) as HTML that matches the PDF layout. It can be toggled off.

Form sections, top to bottom:
1. **Kunde**: combobox with search; "Neuer Kontakt" inline; address picker if there are several addresses; shows VAT-ID status (✓ geprüft am …).
2. **Kopf**: Dokumenttyp (Rechnung / Abschlag / Teil / Schluss …), Rechnungsdatum (set at finalisation; editable with a backdating rule), **Leistungsdatum / -zeitraum / -monat** (mandatory, UST-08), Betreff, Referenz / Bestellnummer (BT-13), Leitweg-ID (if public customer), Kopftext (text template picker with placeholders).
3. **Positionen**: editable table rows: drag handle · Produkt/Beschreibung (autocomplete products) · Menge · Einheit · Einzelpreis (net or gross per document toggle) · USt-Kategorie/-Satz · Rabatt (% / €) · Summe. Row types: **Position**, **Überschrift**, **Text**, **Zwischensumme**, **Optional** (quotes only), **Arbeitskosten/Material** flag (MISC-07). "+ Position", "+ Produkt", "+ Zeiten übernehmen", "+ Gesamtrabatt/Aufschlag".
4. **Steuern & Zahlung**: Steuerfall (auto-derived from customer + products: Inland / EU-B2B-Leistung / igL / Export / §13b / KU; overridable with an explanation), Zahlungsziel, Skonto, Zahlungsart, bank account, EPC-QR on/off.
5. **Fußtext** and attachments.
6. **Totals card** (sticky at the bottom of the form): net per rate, VAT per rate, gross, minus advances (Schlussrechnung), Zahlbetrag.

**Compliance panel** (collapsible, right side of the totals): live checklist from the domain validators, e.g. ✓ Leistungsdatum · ✓ USt-IdNr Kunde geprüft · ✗ Geschäftsführer fehlt im Firmenprofil. The "Fertigstellen" button stays disabled until there are no blocking errors. Warnings (e.g. generic description) do not block.

**Mobile (< 768):** a single column of collapsible sections. The totals bar is sticky at the bottom, above the action bar `[Vorschau] [Speichern ▾]`. "Vorschau" opens a full-screen sheet with the PDF. Position rows edit in a bottom drawer (one row per drawer: Beschreibung, Menge, Preis, USt) to avoid cramped inline tables. Number inputs use `inputmode="decimal"`.

**Finalise flow:**
1. "Fertigstellen" opens a confirm dialog that summarises number (preview), date, total, E-Rechnung format (ER-03 decision shown: "E-Rechnung Pflicht (B2B Inland ab 2027)" / "PDF erlaubt (Zustimmung liegt vor)"), and the immutability notice.
2. Server finalises: assigns the number, freezes the snapshot, renders PDF + XML, validates, archives and hashes.
3. Success shows the next steps „Exportieren ▾" / „E-Mail-Text kopieren" / „Als versendet markieren" / „Später"; see §4.4.

### 4.4 Export and „Als versendet markieren"

**The app never transmits documents** (02 §9). The owner exports the files, sends them with their own mail program (or by post/portal), and then records the dispatch. F04 SND-16…24 is normative (reminders: F05 DUN, same dialogs); UI shape:

**Export dialog** („Exportieren ▾" on the detail page, the list row and the success step of the finalise dialog):
- Entries: E-Rechnung (ZUGFeRD-PDF), XRechnung (XML), XRechnung + Lesefassung (PDF), PDF (format `none` and non-invoice types), Nur XML, Alles als ZIP (incl. attachments marked for export and `SHA256SUMS.txt`). The default entry follows the document's format; a badge names the legally required files (ER-03: „Pflicht: strukturierte E-Rechnung").
- Files are the archived bytes; the original is served while the document has no effective mark, afterwards the „Kopie" variant (re-exporting the original asks for a reason, audited).
- „E-Mail-Text kopieren" panel: subject and body from the `message_text` template (document type + language), the contact's invoice address(es), each with a copy button, optional `mailto:` link (subject/body only). Nothing is sent or logged (SND-19).
- Mobile: „Teilen" via the Web Share API with files where supported, else download. Exporting changes no status; it writes `document.export` to the audit trail.
- Footer: „Jetzt als versendet markieren" opens the mark dialog with the exported files preselected.

**„Als versendet markieren" dialog** (⚠ action, fresh session; bookkeeper or owner):
- Fields: Versanddatum (date picker, ≤ today, default today), Kanal (radio: „E-Mail aus eigenem Programm", „Post", „Persönlich übergeben", „Portal-Upload", „Sonstiges" + checkbox „elektronisch übermittelt"), Übergebene Dateien (checkboxes over the archived artifacts, preselected from the last export), Notiz (optional).
- Live validation: `MUST_E` invoices need the structured file and an electronic channel on the first effective mark (SND-17; error texts from F04 §5); PDF to a B2B customer without recorded consent warns (MAIL-01); a repeated mark shows „Bereits als versendet markiert am {Datum}" (SND-18).
- Shows the resulting Zugang („Zugang: {Datum}", post + N days) and that dunning/Verzug starts from it (SND-23).
- On success the status chip changes to „Versendet" and the export to-do closes (SND-21).

**Retraction** („Versandmarkierung zurücknehmen", Verlauf tab, owner): picks the mark, reason ≥ 10 characters, shows the effect on status/Zugang before confirming; blocked when a finalised reminder depends on the mark (SND-18).

**Bulk** (list selection): „Sammel-Export" (ZIP job with `index.csv`) and „Sammel-Markierung" (one date/channel/note; per-document validation, skipped documents listed with the reason), max 2,000 (SND-20).

Marks, retractions and exports appear in the document's „Dateien"/„Verlauf" tabs (MAIL-02). The list filter „exportiert, nicht markiert" and the to-do after 2 days surface forgotten marks (SND-21).

### 4.5 Receipt inbox (Posteingang)

A three-column triage on desktop: **list** (sources: E-Mail, Upload, App, E-Rechnung) · **document viewer** (PDF/image, or the rendered XRechnung) · **extracted form** (supplier, date, number, net/VAT per rate, category/SKR account suggestion with confidence, payment status, link to bank transaction). Keyboard: `j/k` next/prev, `Enter` accept, `e` edit, `d` mark duplicate. On mobile the viewer and the form are swipeable tabs.

### 4.6 Bank matching (Zuordnungen)

Each card pairs a transaction with its best match(es): score, reason chips ("Rechnungsnr. im Verwendungszweck", "Betrag exakt", "IBAN bekannt"). Actions: ✓ Bestätigen, ✗ Ablehnen, ↔ Andere wählen, + Neuer Beleg, Privat, Geldtransit. "Alle sicheren bestätigen" applies to matches with score ≥ 0.95.

### 4.7 Dashboard (Übersicht)

Replicates sevdesk's „Übersicht“ (observed 2026-10-18, desktop) — **reason for the change: sevdesk parity, owner request 2026-10-18**; replaces the earlier widget list (Offene Forderungen / Umsatz / Liquidität / Steuer-Rücklage / KU / To-dos / Letzte Aktivität). One read `dashboard.overview` (`convex/dashboard.ts`, permission `dashboard.read`) returns a plain view model; the arithmetic is pure in `src/domain/reports/dashboard.ts` and `src/domain/audit/describe.ts`. Layout top to bottom, container queries on `@container/main` (one column on phones, sevdesk layout from `@3xl/main`):

1. Heading „Herzlich Willkommen, {Vorname}“ (no subtitle).
2. Four quick-action tiles (links): „Rechnung schreiben“ `/rechnungen/neu`, „Ausgabe hochladen“ `/posteingang`, „Zahlungen zuordnen“ `/bank/zuordnungen`, „UStVA vorbereiten“ `/steuern/ustva`; 2 × 2 on phones.
3. Full-width „Gewinn vor Steuern“ with Einnahmen (blue) / Ausgaben (red), a 12-month grouped column chart and the footer „Letzte 12 Monate“.
4. Widget grid (2 columns from `@3xl/main`, cards flow so a hidden card's slot is taken by the next one): „Ausstehende Rechnungen“, „Kleinunternehmergrenze“ (only if KU), „Bank“, „Zuordnungsquote“, „Top 5 Kunden“, „Verlauf“, „Aufgaben“.

| ID | Requirement | Priority | Phase |
|---|---|---|---|
| DASH-001 | Greeting „Herzlich Willkommen, {Vorname}“: first word of `members.name` (copied from the Better Auth user at sign-up); if the name is empty, contains „@“ or equals the e-mail → the e-mail local part; else „Herzlich Willkommen“ alone. The heading is the page's `h1#page-title` (also rendered while loading) | MUST | P1 |
| DASH-002 | Four quick-action tiles (bordered cards, icon top-left, bold label) as links; tiles for acts the role may not perform are hidden (Rechnung schreiben / Ausgabe hochladen: `documents.write`, Zahlungen zuordnen: `banking.match`, UStVA vorbereiten: `accounting.read`) | MUST | P1 |
| DASH-003 | „Gewinn vor Steuern“ = Einnahmen − Ausgaben over the months shown: **posted journal lines by entry date** (`journalLines.date`), Einnahmen = Σ(credit − debit) on accounts of type `revenue`, Ausgaben = Σ(debit − credit) on type `expense`, account types from the chart seed valid on today (rule data `src/domain/rules/accounting`, SKR03/SKR04). Labelled „Vorläufig laut Journal (Buchungsdatum), nicht die EÜR“: the EÜR cash-basis figures need payment allocations (F08 §4.4, TAX-015, P3). Window: 12 calendar months ending with the current month (`Nov 25 … Okt 26` on 2026-10-18; German month abbreviations as fixed data). A Storno nets its month; a negative month draws no bar but keeps its value in the table. Plain CSS columns (no chart library), `role="img"` with a label plus a visually hidden table Monat/Einnahmen/Ausgaben/Gewinn; empty text „In den letzten 12 Monaten gibt es noch keine Buchungen.“ | MUST | P1 |
| DASH-004 | „Ausstehende Rechnungen“: grey box „Ausstehender Betrag“ = Σ open amount of open items (F05 PAY-001, `openItemsAsOf(today)`) with a positive EUR open amount (open refunds and other currencies excluded); three **disjoint** rows with count pill, label, amount and chevron link: „Fällig“ (past due, also when partially paid) → `/rechnungen?status=overdue`, „Offen“ (not due, nothing paid) → `/rechnungen?status=open`, „Teilbezahlt“ (not due, partially paid) → `/rechnungen?status=open` (the list has no partially-paid filter; its „Offen“ tab is a superset); the rows sum to the box; footer button „Rechnung schreiben“ (`documents.write`) | MUST | P1 |
| DASH-005 | „Kleinunternehmergrenze“ only if the company is KU on today (`companyProfile.kleinunternehmer` history): grey box „Umsatz {Jahr}“ = Σ gross of finalised, not cancelled invoices (type `invoice`) dated in the current year — the same sum as the finalise-time KU check (KU-01; for a KU gross = net); progress bar against the limit of `kleinunternehmer_limits` valid on today via `lookupRule` (founding-year limit if `foundedOn` is in the current year, else the current-year limit; levels from `warnAtBp`), label „Umsatzsteuerpflicht {Grenze}“ and the explanation built from the prior- and current-year limits of the same row; no row → „Für {Jahr} ist noch keine Umsatzgrenze hinterlegt.“ (never a literal amount) | MUST | P1 |
| DASH-006 | „Bank“: „Gesamtsaldo“ = Σ closing balance of the latest (not rolled back) statement of the active EUR bank accounts (what `/bank` shows); accounts without a statement balance are named („1 Konto ohne Kontoauszug-Saldo“); the latest 4 transactions of those accounts (not `ignored`) with counterparty (else purpose), date and signed amount; link „Alle Zahlungen anzeigen“ → `/bank`; no account → „Noch kein Bankkonto angelegt.“ + „Bankkonto hinzufügen“ | MUST | P1 |
| DASH-007 | „Zuordnungsquote“ (our „Buchhaltungsscore“): assigned (`matched`, `booked`, `private`, `transfer`) / all bank transactions except `ignored`, floored to whole percent (100 % only when nothing is unassigned); 3-colour scale < 85 red, 85–99 amber, 100 green (UI heuristic, not legal data) with level text and icon; „Zahlungen ohne Zuordnung: {n}“ (`open` + `partially_matched`); button „Zuordnen“ → `/bank/zuordnungen` (`banking.match`); one explanatory sentence; no transactions → „Noch keine Bankumsätze vorhanden.“ | MUST | P1 |
| DASH-008 | „Top 5 Kunden“: the five contacts with the highest **invoiced payable amount** (`totals.payableCents`, so advance/final chains are not counted twice) of finalised invoices (`invoice`, `advance_invoice`, `partial_invoice`, `final_invoice`; status `finalized`/`sent`; EUR) with document date in (today − 3 months, today]; cancelled invoices and Storno documents excluded (the pair nets to zero), Rechnungskorrekturen not yet netted; ties by name; Σ ≤ 0 omitted; ranked list; empty text „In diesem Zeitraum sind keine Daten vorhanden.“ | MUST | P1 |
| DASH-009 | „Verlauf“: the latest 5 business acts from the audit log as German lines („RE-2026-0001 fertiggestellt“, „Zahlung zu RE-2026-0001 erfasst“) with timestamp (Europe/Berlin) and actor shown by role or channel (Inhaber, Buchhaltung, API, KI-Assistent (MCP), System) — never e-mail, IP or diff; technical entries (artifact pipeline, sign-ins, integrity runs, auditor access, journal postings, notifications) are skipped and repeats of the same act on the same entity shown once; only for roles with `audit.read` (currently all) | MUST | P1 |
| DASH-010 | „Aufgaben“: the existing to-do list (F04 SND-21, REC-16) stays as the last card — sevdesk has none, but the export/send to-dos are part of the invoice workflow | MUST | P1 |
| DASH-011 | `dashboard.read` for every member role (owner, bookkeeper, viewer, auditor), not grantable to API keys; each widget is additionally gated by the read permission of its data (`accounting.read`, `payments.read`, `documents.read`, `banking.read`, `audit.read`) and is `null`/hidden otherwise | MUST | P1 |

Open questions for the owner: sevdesk's chart labels read „Okt 25 … Okt 26“ (13 months incl. the current one) while its footer says „Letzte 12 Monate“ — we show 12 (`DASHBOARD_MONTHS`). Top 5 Kunden by invoiced amount (sevdesk-like „Umsatz“) rather than by payments received.

Follow-ups: „Top 5 Ausgaben“ and „Produkte & Dienstleistungen“ (need purchase vouchers, F06); a „Teilbezahlt“ filter in the invoice list; Rechnungskorrekturen in Top 5 Kunden; cash-basis Einnahmen/Ausgaben once payment allocations exist (TAX-015); liquidity forecast, tax reserve and the 800k monitors (RPT-002, P3).

### 4.8 Settings

Grouped navigation on the left (desktop) or a list (mobile). Each settings page validates on save and shows the downstream effect, e.g. changing the legal form shows "Pflichtangaben im Fußtext: + Registergericht, + HRB, + Geschäftsführer".

**Setup wizard** (first run, owner only, mandatory before the first invoice; F01 §3.1): Inhaberkonto (passkey enrolment, optional TOTP) → Adressen & Zugriff (`BASE_DOMAIN` hosts check, tailnet confirmation, server location AO-06) → E-Mail-Versand (Cloudflare sender check, test code to the owner) → Speicher (R2 checkpoint bucket test, bucket-lock check, backups seen) → Unternehmen (legal form, name, address) → Steuern (Steuernummer, USt-IdNr, KU yes/no, Soll/Ist, UStVA-Zeitraum, EÜR/Bilanz, chart of accounts default **SKR03**) → Bank (IBAN, BIC, account holder) → Layout (logo, color) → Nummernkreise → done. The wizard can be resumed later.

### 4.9 Sign-in, passkeys, e-mail code, session expiry

All auth pages are German, single-column, centred card (max 420 px), usable on phones; no app shell. Better Auth runs behind `/api/auth/*` (02 §4.2).

**`/anmelden`**
- E-mail field with `autocomplete="username webauthn"` and **passkey conditional UI** (`signIn.passkey({ autoFill: true })`): on supported browsers the stored passkey is offered directly in the autofill list.
- Primary button „Mit Passkey anmelden"; secondary „Code per E-Mail senden" (e-mail OTP).
- No password field, no „Registrieren" link. An unknown or uninvited address gets the same neutral answer after requesting a code („Falls für diese Adresse ein Zugang besteht, wurde ein Code gesendet."), except during first run (below).
- First run (no user exists): the page shows „Ersteinrichtung — Anmeldung nur mit der hinterlegten Inhaber-E-Mail-Adresse" and accepts only `OWNER_EMAIL` (02 §4.3).

**`/anmelden/code`**: six single-digit inputs (`inputmode="numeric"`, `autocomplete="one-time-code"`, paste fills all), 10-minute validity shown as a countdown, „Neuen Code senden" (disabled for 60 s; per-address throttle 5/hour, message „Zu viele Codes angefordert — bitte in {n} Minuten erneut versuchen."). Wrong code → „Der Code ist falsch oder abgelaufen." (attempts limited by Better Auth).

**`/anmelden/zwei-faktor`**: shown after an e-mail-code sign-in if the member enabled TOTP; 6-digit TOTP input; „Passkey verwenden" as alternative. Until verified no session exists (02 §4.2), so every other route redirects to `/anmelden`.

**`/anmelden/passkey-einrichten`**: shown after the first e-mail-code sign-in of a member without a passkey. For the **owner it is mandatory** (part of the setup wizard step „Inhaberkonto"); other roles may choose „Später" (reminded on the next three sign-ins). Explains in one sentence that the passkey works only on `<BASE_DOMAIN>` and that the e-mail code stays the recovery path.

**`/konto`**: passkey list (device name, created, last used; rename; remove — removing the last passkey of the owner requires a fresh sign-in and shows a warning), TOTP setup (QR code + manual key + confirmation code; disable requires a fresh session), active sessions with „Andere Sitzungen abmelden", „Abmelden".

**Session expiry and re-authentication**
- Session lifetime 7 days, refreshed daily while used; the Convex token (15 min) refreshes silently.
- When the session ends (expired, revoked, member expired/disabled), the next Convex call or Server Action fails with an auth error. The app then shows the **modal „Sitzung abgelaufen"** („Bitte melden Sie sich erneut an. Ungespeicherte Eingaben bleiben erhalten.") with „Erneut anmelden" (passkey or code in the modal, without leaving the page). Draft forms autosave locally (IndexedDB) before the modal opens and are restored after sign-in; if the role no longer allows the page, the user lands on `/` with an explanatory toast.
- **Fresh session for ⚠ actions** (finalise, Storno, payments, period lock, DATEV with lock, purge, member and API-key changes): if the session is older than 10 minutes, the confirm dialog first asks for a passkey assertion (or a new e-mail code) — „Zur Bestätigung bitte erneut mit Passkey bestätigen."
- Live subscriptions pause while signed out; no data stays rendered behind the modal (content is blurred and `aria-hidden`).

### 4.10 Members, roles and invites (`/einstellungen/mitglieder`, owner only)

- Table: Name/E-Mail · Rolle (Inhaber, Buchhaltung, Lesezugriff, Prüfer) · Passkey ✓/– · TOTP ✓/– · Gültig bis · Letzte Anmeldung · Aktionen (Rolle ändern, Verlängern, Deaktivieren, Sitzungen abmelden). The owner row cannot be changed or removed. Mobile: cards.
- „Person einladen" dialog: e-mail, role, optional „Gültig bis" (mandatory and ≤ 30 days for „Prüfer"); for „Prüfer" additionally Wirtschaftsjahre (multi-select), Prüfungsanordnung/Aktenzeichen, Organisation. Sending creates the invite (valid 7 days) and an e-mail with sign-in instructions (Cloudflare, 02 §9); the dialog explains that the invited person needs **a device inside the tailnet** (owner's device on site, or a tailnet invitation — link to the Verfahrensdokumentation „Prüferzugang-Anleitung").
- Open invites list: E-Mail · Rolle · gesendet · läuft ab · „Erneut senden" / „Zurückziehen". A failed invite mail shows the Cloudflare error in German.
- Role changes, deactivation and invites are ⚠ actions (fresh session) and audited (`member.*`, `invite.*`).
- **Role-aware UI everywhere:** actions the current role may not perform are hidden (or disabled with a tooltip where the absence would confuse, e.g. „Fertigstellen — nur mit Rolle Buchhaltung oder Inhaber"). Viewers and auditors see a persistent banner: „Lesezugriff" / „Prüferzugang (nur Lesen) · gültig bis {datum} · Zeitraum {jahre}". The server is authoritative (02 §4.3); hiding is only convenience.

### 4.11 Payments: „Zahlung buchen" and „Bezahlt mit"

- **Invoice „Zahlung buchen"** (F05 PAY-061…063): field **„Bezahlt mit"** — segmented control „Bank" · „Bar" · „Andere" (Andere = clearing/PayPal accounts, F07). „Bank" offers the open bank transactions as suggestions or records a manual bank payment; „Bar" books to the cash account (`source.kind = "cash"`). Date (≤ today; warning „Bareinnahmen sind täglich aufzuzeichnen" when more than 1 day back for cash; a reason field appears when more than 10 days back), amount (default: open amount), optional note; excess handling per PAY-030. After a cash payment: „Quittung drucken" (optional).
- **Voucher „Buchen"** (F06 VOU-136): field **„Bezahlt mit"** — „Offen – Zahlung per Bank folgt" (default) · „Kartenzahlung/Lastschrift – Bankumsatz folgt" · „Bar bezahlt" · „Privat bezahlt" (for corporations labelled „Vom Gesellschafter bezahlt", needs the shareholder clearing account, F01 SET-045a). Income vouchers offer Bank and Bar only. The OCR hint only preselects. A failed cash check books nothing and offers „Privat bezahlt" instead.
- Both dialogs show the resulting posting in plain German („Kasse an Forderung 119,00 €") as a collapsible detail and block in locked periods.

### 4.12 Kasse (`/kasse`, P1)

Small page, not a cash book (F07 CSH-020…030, §6.7): current balance (large), movement list with running balance (Datum, Beleg, Text, Einnahme, Ausgabe, Bestand; each row links to its invoice, voucher or Eigenbeleg), buttons „Bargeld eingezahlt / entnommen" (one dialog: Einzahlung auf Bank, Privatentnahme; for corporations the withdrawal goes to the shareholder clearing account; ATM withdrawals into the till are marked on the bank transaction; live never-negative check with the projected minimum) and „Bericht (PDF/CSV)". Banner: „Kein Kassensystem – Bareinnahmen nur zu Rechnungen". Corrections are reversals („Stornieren" with reason). Mobile: single column, big amount input.

### 4.13 Bank connection (`/einstellungen/bank/verbindung`, owner only, P2)

Per F07 BNK-101…115, §6.5:
- **Setup checklist** with copy buttons (Enable Banking application ID, redirect URL `https://app.<BASE_DOMAIN>/einstellungen/bank/callback`) and status of the written restricted-mode confirmation.
- **„Bank verbinden" / „Neu verbinden"** (⚠, fresh session): bank picker (Enable Banking `aspsps`), shows the consent period („Zugriff für 180 Tage") and redirects to the bank; the bank sends the browser back to **`/einstellungen/bank/callback`** (tailnet host; works because the owner's own browser follows the redirect). The callback page shows „Verbindung wird hergestellt…", then the shared accounts with a mapping table (IBAN, currency → bank account, „nicht synchronisieren") and returns to the connection page; an error or cancelled consent shows the bank's reason in German and „Erneut versuchen".
- **Consent card**: „gültig bis {Datum}, noch {n} Tage" with the T−14/T−3/expired states (banner on `/bank` and the dashboard), last sync per account, unattended fetches today x/4, backoff until, „Jetzt abrufen" (owner present, BNK-107), „Trennen" (⚠).
- No credentials of the bank are ever entered in the app.

## 5. Command palette and shortcuts

`⌘K` / `Ctrl K` opens the palette: global search (documents by number/customer/amount, contacts, products, settings pages) plus actions ("Neue Rechnung für …", "Zahlung buchen RE-1042", "Gehe zu UStVA").

| Shortcut | Action |
|---|---|
| `⌘K` | Command palette |
| `/` | Focus search in the current list |
| `n` then `r`/`a`/`k`/`p` | New Rechnung / Angebot / Kontakt / Produkt |
| `j` / `k` | Next / previous row |
| `Enter` | Open |
| `⌘S` | Save draft |
| `⌘Enter` | Primary action (Fertigstellen / Exportieren) |
| `⌘B` | Toggle sidebar |
| `?` | Shortcut help |

## 6. Status system

| Status | Badge color (token) | Applies to |
|---|---|---|
| Entwurf | `muted` grey | all documents |
| Offen / Versendet | `info` blue | invoices, quotes |
| Teilbezahlt | `warning-soft` amber outline | invoices, receipts |
| Überfällig | `destructive` red | invoices |
| Bezahlt / Angenommen / Berechnet | `success` green | |
| Abgelehnt / Abgelaufen | `muted` strikethrough | quotes |
| Storniert | `muted` + "Storno" tag | invoices |
| Festgeschrieben | 🔒 lock icon suffix | all locked records |

Invoice badges come from the pure `displayStatus()` (F04 §4.2.9): „Offen“, „Teilbezahlt“, „Überfällig“ and „Bezahlt“ are derived from the stored `status` + `paymentStatus` + due date; **„Überfällig“ is never stored** (02 §6). List filters therefore use `display_status`, e.g. `?status=overdue` maps to `display_status=overdue`.

Color is never the only signal: every status has text, and overdue also has an icon. Contrast ≥ 4.5:1 in both themes.

## 7. Accessibility (MISC-10)

- WCAG 2.1 AA. `@axe-core/playwright` runs on every E2E page visit; any violation fails CI (allowlist only with a ticket reference).
- Full keyboard operability; visible focus ring; focus is trapped in dialogs and returned on close.
- Touch targets ≥ 44 × 44 px on mobile.
- Respect `prefers-reduced-motion` (§7.1 MOT-007).
- Form errors are announced (`aria-live="polite"`) and linked via `aria-describedby`.

### 7.1 Motion

Owner request 2026-10-18: interactions should feel less abrupt. Motion is short (≤ 250 ms for feedback, ≤ 650 ms for chart entrances), eased out, never blocks input, and is switched off completely for `prefers-reduced-motion`. Utilities live in `src/app/globals.css` (`animate-rise`, `animate-grow-y`, `animate-grow-x`, `--motion-delay` for staggering).

| ID | Requirement | Priority | Phase |
|---|---|---|---|
| MOT-001 | After a page change the main area fades and slides in (≈ 220 ms, Web Animations API, no remount); the first load does not animate | SHOULD | P1 |
| MOT-002 | Opening a sidebar area slides its sub-items in; sidebar items fade their background and text colour | SHOULD | P1 |
| MOT-003 | Large link tiles (Übersicht quick actions) lift slightly on hover and settle on press; buttons keep their 1 px press offset | SHOULD | P1 |
| MOT-004 | Übersicht cards rise in one after another (60 ms stagger) when the data arrives | SHOULD | P1 |
| MOT-005 | Chart bars grow from the baseline month by month; progress bars fill from the left | SHOULD | P1 |
| MOT-006 | Phone list cards scale down slightly on press; status tabs fade between states; table rows fade their hover colour | SHOULD | P1 |
| MOT-007 | With `prefers-reduced-motion: reduce` every animation and transition is effectively instant (no delays, no page fade). E2E runs with reduced motion so axe never inspects a half-faded element | MUST | P1 |

## 8. Number, date and currency handling

- Display: `Intl.NumberFormat('de-DE', { style: 'currency', currency })`, and `Intl.DateTimeFormat('de-DE')` → `12.10.2026`.
- Parsing (`src/domain/money/parse.ts`):
  - `1.234,56` → 123456 cents
  - `1234,56` → 123456 cents
  - `1234.56` → 123456 cents (one dot and ≤ 2 decimals = decimal point)
  - `1.234` is ambiguous → interpreted as **1234** (German thousands separator) and shown back formatted, so the user sees the interpretation immediately.
- Unit prices allow up to 4 decimals; quantities up to 3 decimals (sevdesk complaint: too few decimals).
- Percentages: 2 decimals.

## 9. Performance budgets (checked in CI with Playwright traces)

| Metric | Budget |
|---|---|
| LCP on the dashboard (Moto G-class throttling) | < 2.5 s |
| Route transition (client) | < 300 ms |
| Editor keystroke → totals update | < 50 ms (pure client calculation, shared `domain` module) |
| Invoice list with 5,000 rows | smooth scroll (virtualised), filter < 150 ms |
| PDF preview refresh | < 1.5 s |

## 10. PWA (P2)

- `manifest.webmanifest` (name, icons from `assets/icon.svg`, `display: standalone`, theme colors).
- Service worker (Serwist): caches the app shell only. **No offline invoicing** (numbering must be server-side). An offline queue (IndexedDB) exists only for receipt photos and time entries, synced via background sync.
- Share target: share a PDF from another app → receipt inbox.

## 11. Visual regression

Playwright `toHaveScreenshot` for each key page × {Desktop Chrome 1440×900, iPhone 15, Pixel 7} × {light, dark}. Baselines are generated in the official Playwright Docker image (`mcr.microsoft.com/playwright:v1.64.0-noble`) so fonts match in CI. Volatile content (dates, live counters) is masked via `stylePath`. See [07-testing.md](07-testing.md).

Key pages with baselines: Anmelden (passkey, code entry, TOTP), Dashboard, Rechnungsliste, Rechnung-Detail, Rechnungs-Editor (empty, filled, with validation errors), Export menu + mark-sent dialog, Kontakt-Detail, Produktliste, Posteingang, Bank-Zuordnungen, UStVA, Einstellungen › Unternehmen, Einstellungen › Mitglieder, Setup wizard steps, session-expired dialog, auditor read-only banner, mobile bottom-nav + create drawer.
