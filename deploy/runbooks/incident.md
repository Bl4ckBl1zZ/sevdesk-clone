# Runbook: security incident and personal-data breach

Source: 01 DSGVO-05 (breach-response doc), Art. 33/34 DSGVO, 08 §7.1 · related: [restore.md](restore.md),
[go-live.md](go-live.md), security page `/einstellungen/system/sicherheit` (F12 AUD-020).

The owner is the controller. A **personal-data breach** is any security incident that leads to the accidental or
unlawful destruction, loss, alteration, unauthorised disclosure of, or access to personal data (customer contacts,
invoices, bank data, member accounts). Lost or stolen devices with an active session count too.

**Deadline:** the competent supervisory authority (Landesdatenschutzbehörde of the business's federal state) must be
notified **within 72 hours** after the owner became aware of the breach (Art. 33 (1) DSGVO), unless it is unlikely
to result in a risk to the rights and freedoms of natural persons. Late notifications need a reason.

## 1. Detect and record (hour 0)

1. Note the time you became aware, who reported it, and what was observed. Start the breach record (§7) now.
2. Triggers: integrity check failed (F12 AUD-013), unknown sign-in or session on the member list, unexpected
   API-key use in the audit log, a lost device, a leaked secret, a provider's breach notice (Cloudflare, Tailscale,
   hoster), a misdirected e-mail with an invoice.

## 2. Contain (as fast as possible)

| Situation | Action |
|---|---|
| Account or device compromised | Einstellungen › Mitglieder › „Sitzungen abmelden" for the member (owner: all sessions), remove lost passkeys, disable the member if needed |
| API or MCP key leaked | Einstellungen › API-Schlüssel › widerrufen (immediate) |
| Device lost | Remove the device from the tailnet (Tailscale admin console → Machines → Remove); revoke its sessions as above |
| Server or secret compromised | Rotate secrets (below), redeploy; if the host is suspect, take the caddy Tailscale Service offline (Dokploy → compose → caddy → Stop) |
| Backup or R2 token leaked | Revoke the token in the Cloudflare dashboard, create a new one, update `/opt/rechnungen/backup.env` / the Convex env |

**Secret rotation** (08 §5.2): `BETTER_AUTH_SECRET` + `JWKS` (`auth:rotateKeys`; signs everyone out),
`JWT_PRIVATE_KEY_PEM` + `SERVER_JWKS`, `APP_ENCRYPTION_KEY` (re-encrypt stored secrets first), Cloudflare and R2
tokens, `CONVEX_DASH_BASIC_AUTH`, the Convex admin key. `CHECKPOINT_SIGNING_KEY_PEM` only if it leaked (new `kid`,
keep the old public key). Afterwards set `SECRETS_ROTATED_ON` in the Convex env.

## 3. Preserve evidence

- Do **not** delete data or reset the server before evidence is saved.
- Run „Integrität prüfen" (Einstellungen › Protokoll) and export the audit log for the affected period.
- Copy the technical logs of the affected period now — they are rotated after at most 90 days (DSGVO-06):
  `docker logs --since <time> <container> > incident-<date>-<service>.log` for caddy, web and backend; access logs
  contain only truncated IP addresses and no cookies or credentials (by design).
- Keep the copies encrypted and outside the server; delete them when the case is closed.

## 4. Assess the risk

Answer in the breach record: which categories of data (contact data, invoice contents, bank data, health or other
special categories — normally none), approximately how many data subjects and records, whether the data was
encrypted or only availability was affected, likely consequences (fraud, phishing with real invoice data,
reputational harm), and whether the breach is ongoing.

- **No risk likely** (e.g. lost device with full-disk encryption and the session revoked) → document only (§7).
- **Risk** → notify the supervisory authority (§5).
- **High risk** (e.g. bank details or full invoice data disclosed to unknown parties) → also inform the data
  subjects (§6).

## 5. Notify the supervisory authority (Art. 33 DSGVO, ≤ 72 h)

Use the online form of the competent Landesdatenschutzbehörde. Content (Art. 33 (3)): nature of the breach,
categories and approximate number of data subjects and records, contact details of the owner, likely consequences,
measures taken or proposed. Information may be provided in phases if not everything is known within 72 hours.

## 6. Inform the data subjects (Art. 34 DSGVO, high risk)

Without undue delay, in clear and plain language (German): what happened, which data, likely consequences, what
was done, what they can do (e.g. watch for fake invoices with changed bank details), and the owner's contact.
Not required if the data was protected (e.g. encrypted) or a public notice is equivalent because individual
contact would be disproportionate (Art. 34 (3)).

## 7. Document (always, Art. 33 (5) DSGVO)

Every breach is documented — also those not notified. Keep the record with the Verfahrensdokumentation:

| Field | Content |
|---|---|
| Aware since | date/time, by whom |
| What happened | description, affected systems and data |
| Data subjects / records | categories, approximate numbers |
| Risk assessment | none / risk / high risk, reasoning |
| Measures | containment, rotation, restore, follow-ups |
| Notifications | authority (date, reference), data subjects (date, channel) — or the reason why not |
| Closed | date, lessons learned |

## 8. Processors

Processors (Cloudflare, Tailscale, the hosting provider) must report breaches to the owner without undue delay
(Art. 33 (2) DSGVO, AVV). Their notices start this runbook at §1. Check the processors list in the
Verfahrensdokumentation for current contacts.

## 9. Recover and review

- Restore data if it was altered or lost ([restore.md](restore.md)); the restore is logged (`system.restore`).
- Check the security page: all checks green again.
- Review: what made the breach possible, what changes prevent it (config, tests, a new `EC-` entry in
  `docs/spec/10-edge-cases.md` if it was a legal or data-handling bug).
