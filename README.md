<img src="assets/icon.svg" width="64" height="64" alt="">

# sevdesk-clone

Self-hosted German invoicing & bookkeeping (sevdesk replacement) for a single small business — compliant with UStG, E-Rechnung (XRechnung/ZUGFeRD), GoBD and DSGVO, fully operable via **MCP (Claude Code / Claude Desktop)** and a **REST API with webhooks**. Runs **tailnet-only** (no public host) with passkey login.

- **Spec:** [`docs/spec/README.md`](docs/spec/README.md)
- **Research:** [`docs/research/`](docs/research/)
- **Agent rules:** [`CLAUDE.md`](CLAUDE.md)

Stack: Next.js 16.4 · self-hosted Convex · Better Auth (passkey + e-mail code) · shadcn/ui + Tailwind 4 · Vitest + Playwright (TDD) · deployed on a Dokploy fork as a Tailscale Service behind a Caddy TLS edge · Cloudflare (DNS, auth e-mail, R2 backups) · bank sync via Enable Banking.

> Status: specification phase (v1.1, 2026-10-12). No application code yet.
