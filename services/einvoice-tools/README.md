# einvoice-tools sidecar

Internal HTTP service (02 §8) wrapping the official validators. Reached only on the compose network as
`http://einvoice-tools:8080` — never published (no `expose`/`ports`, 08 §3.1).

| Tool | Version | Pinned in |
|---|---|---|
| KoSIT validator (daemon mode `-D`, localhost:8081) | 1.6.3 | `Dockerfile` (URL + SHA-256) |
| XRechnung validator configuration | `xrechnung-3.0.2-validator-configuration-2026-08-31` | `Dockerfile` |
| Mustang CLI (ZUGFeRD/Factur-X + veraPDF PDF/A) | 2.26.0 | `Dockerfile` |
| Runtime | Temurin 17 JRE (Ubuntu noble) + Node 24 binary | `Dockerfile` |

## API

| Endpoint | Body | Response |
|---|---|---|
| `POST /validate/xml` | XML (UBL/CII) | `200 { acceptable, valid, scenario, errors[], warnings[], infos[], reportXml, validatorVersion, configVersion }`; `422 { error: "processing_error", … }` for unreadable input; `503` while the daemon is down |
| `POST /validate/pdf` | PDF | `200 { valid, pdfValid, pdfaValid, pdfaFlavour, xmlValid, xmlPresent, profile, errors[], warnings[], reportXml, mustangVersion }` |
| `POST /visualize` | XML | `text/html` (Mustang `--action visualize --language de`; fallback viewer only) |
| `GET /health` | — | `{ status, version, kosit: { status, version }, xrechnungConfig, mustang, node }`; **503** until the KoSIT daemon is up |

Messages are `{ code, level, location, text }`; `code` is the business-rule ID (e.g. `BR-DE-15`) when available.
`acceptable` is KoSIT's verdict (HTTP 200 + `rep:accept`) and is what ER-12 uses to block finalisation.

Implementation: zero-dependency Node server (`node:http`, Node 24 runs the `.ts` sources directly via type
stripping). Deviation from 02 §8 ("Hono"): no framework is needed for four routes, and a dependency-free image
avoids a pnpm install step in the sidecar build (ADR 0003).

## Develop / test

```bash
pnpm test -p deploy                          # unit tests (fake daemon + captured real reports; no Java needed)
pnpm exec tsc -p services/einvoice-tools     # typecheck
docker build -t einvoice-tools services/einvoice-tools
docker run --rm -p 127.0.0.1:8080:8080 einvoice-tools
services/einvoice-tools/scripts/smoke.sh http://127.0.0.1:8080   # real validators against the fixtures
```

Without Docker but with a JRE 17: run `src/main.ts` with `JAVA_BIN`, `KOSIT_JAR`, `KOSIT_CONFIG_DIR`, `MUSTANG_JAR`
pointing at the downloaded artefacts (URLs in the `Dockerfile`).

Environment: `PORT` (8080), `KOSIT_PORT` (8081), `KOSIT_XMX` (768m), `MUSTANG_XMX` (1g), `MUSTANG_CONCURRENCY` (2),
`MAX_BODY_BYTES` (25 MiB), `TIMEOUT_MS` (120000), `KOSIT_START=0` to use an external daemon via `KOSIT_URL`.

Fixtures and their licences: `test/fixtures/NOTICE.md`.
