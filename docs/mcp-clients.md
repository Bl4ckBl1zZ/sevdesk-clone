# Claude mit Rechnungen verbinden (MCP)

Der MCP-Server läuft unter `https://api.<BASE_DOMAIN>/api/mcp` und ist **nur im Tailnet** erreichbar (Port 443 des Caddy-Edge; nicht über den Website-Port 8443). Spezifikation: [`spec/06-mcp.md`](spec/06-mcp.md) §1 und §6.

| Client | Unterstützt? | Weg |
|---|---|---|
| **Claude Code** auf einem Gerät im Tailnet | Ja (empfohlen) | direkt per HTTP |
| **Claude Desktop** mit lokaler MCP-Konfiguration | Ja, über eine Brücke | lokaler stdio-Server `mcp-remote` |
| Claude Desktop / Cowork **benutzerdefinierte Connectors** | Nein | Connectors werden über Anthropic-Server aufgebaut, die das Tailnet nicht erreichen |
| **claude.ai** (Web, Mobil) | Nein | wie oben; ein öffentlicher Endpunkt mit OAuth ist bewusst nicht vorgesehen |

## 1. Schlüssel anlegen

1. In der App **Einstellungen › MCP** (nur Inhaber) öffnen.
2. „Schlüssel für Claude erstellen“ wählen:
   - **Claude (MCP), sicher**: alle Lese-Scopes und Schreiben von Kontakten, Produkten, Entwürfen und Belegen. Keine Fertigstellung, keine Zahlungen, kein Mahnlauf.
   - **Claude (MCP), voll**: zusätzlich Fertigstellen, Als-versendet-markieren, Stornieren, Zahlungen und Mahnungen. Jede dieser ⚠-Aktionen braucht trotzdem eine Vorschau mit `confirm_token` und deine Freigabe im Client.
3. Den Schlüssel (`sk_live_…`) sofort kopieren — er wird **nur einmal** angezeigt. Gespeichert wird nur sein SHA-256.

Kanal: `mcp` (oder `both`, wenn derselbe Schlüssel auch für REST genutzt wird). Ein reiner REST-Schlüssel (`api`) wird am MCP-Endpunkt abgelehnt.

## 2. Voraussetzungen auf dem Gerät

- Tailscale ist mit dem Tailnet des Inhabers verbunden.
- Die Tailnet-Richtlinie erlaubt dem Gerät `tcp:443` zum Caddy-Service (05 §6.1).
- Linux-Clients bis Tailscale v1.93: `tailscale set --accept-routes` (Tailscale-Services-VIPs).
- Test: `curl -sS https://api.<BASE_DOMAIN>/api/health` liefert `{"status":"ok",…}`. Außerhalb des Tailnets läuft die Anfrage in einen Timeout.

## 3. Claude Code (direkt)

Schlüssel als Umgebungsvariable hinterlegen (nicht in Dateien im Repository):

```bash
export RECHNUNG_MCP_KEY="sk_live_…"
claude mcp add --transport http rechnungen https://api.<BASE_DOMAIN>/api/mcp \
  --header "Authorization: Bearer $RECHNUNG_MCP_KEY" --scope user
```

Oder projektbezogen in `.mcp.json` (die Variable wird beim Start aufgelöst):

```json
{
  "mcpServers": {
    "rechnungen": {
      "type": "http",
      "url": "https://api.<BASE_DOMAIN>/api/mcp",
      "headers": { "Authorization": "Bearer ${RECHNUNG_MCP_KEY}" }
    }
  }
}
```

Prüfen: `claude mcp list` zeigt `rechnungen` als verbunden; in einer Sitzung `/mcp` aufrufen und z. B. „Gib mir einen Überblick“ eingeben (`workspace_overview`).

## 4. Claude Desktop (über `mcp-remote`)

Claude Desktop startet einen lokalen stdio-Server, der über die Netzwerkverbindung des Geräts (also durch das Tailnet) zum Endpunkt weiterleitet. Voraussetzung: Node.js ≥ 20 (`npx`).

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "rechnungen": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://api.<BASE_DOMAIN>/api/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer sk_live_…" }
    }
  }
}
```

Der Header wird über `env` übergeben, weil manche Plattformen Leerzeichen in `args` falsch zerlegen. Nach dem Speichern Claude Desktop neu starten; unter Einstellungen › Entwickler erscheint `rechnungen` als verbunden.

## 5. Was Claude darf

- **Lesen und Entwürfe** (Kontakte, Produkte, Einstellungen, Belegentwürfe) im Rahmen der Scopes. Die Werkzeugliste enthält nur Werkzeuge, deren Scope der Schlüssel hat.
- **⚠-Aktionen** (z. B. `contact_merge`, später `document_finalize`, `payment_record`): Claude muss zuerst die passende Vorschau aufrufen (`preview_action`, `document_preview`, `dunning_preview`). Die Vorschau liefert die Auswirkung und ein `confirm_token` (10 Minuten, einmalig, an dieselben Parameter und den Datenstand gebunden). Claude Code fragt bei jeder ⚠-Aktion nach deiner Freigabe (`requiresUserInteraction`). Ändern sich die Daten zwischenzeitlich, schlägt der Aufruf mit `preview_outdated` fehl.
- **Nie über MCP:** Löschen festgeschriebener Daten, Schlüssel- oder Mitgliederverwaltung, Anmeldeeinstellungen, Geheimnisse, Löschläufe/DSGVO-Löschung.
- Jede Änderung wird als `mcp:<Schlüssel-ID>` mit Schlüsselname und Client (Name/Version) protokolliert; jede Anfrage steht im Zugriffsprotokoll des Schlüssels (Einstellungen › API › Letzte Zugriffe).
- Rate-Limit: pro Schlüssel (Standard 120 Anfragen/Minute), gemeinsam für REST und MCP.

## 6. Fehlersuche

| Symptom | Ursache / Lösung |
|---|---|
| Timeout beim Verbinden | Gerät nicht im Tailnet, Grant für `tcp:443` fehlt oder `--accept-routes` (Linux) nicht gesetzt |
| `401 unauthorized` | Schlüssel falsch, widerrufen, abgelaufen oder Kanal `api` statt `mcp`/`both` |
| `403` beim Verbinden | Ein `Origin`-Header einer fremden Seite (Schutz vor DNS-Rebinding) — nur bei Browser-Clients |
| Werkzeug fehlt in der Liste | Der Schlüssel hat den nötigen Scope nicht (Einstellungen › API) |
| `429 rate_limited` | Rate-Limit des Schlüssels erreicht; `Retry-After` abwarten oder Limit erhöhen |
| `confirm_token_required` / `preview_outdated` | Vorschau erneut aufrufen und bestätigen |

## 7. Eval vor dem Go-live (06 §7)

`pnpm mcp:eval --list` zeigt die deutschen Test-Prompts. Jeden Prompt in Claude Code gegen eine **Testinstanz** ausführen; erwartet wird das genannte Ergebnis ohne manuelle Korrektur und ohne unbestätigte ⚠-Aktion. Die Referenz-Werkzeugaufrufe lassen sich automatisch gegen eine Testinstanz prüfen:

```bash
RECHNUNG_MCP_URL=https://api.<BASE_DOMAIN>/api/mcp RECHNUNG_MCP_KEY=sk_live_… pnpm mcp:eval
```

Achtung: der Lauf legt Testdaten an — nie gegen die Produktivdatenbank ausführen.
