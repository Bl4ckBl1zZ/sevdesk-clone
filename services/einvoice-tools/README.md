# einvoice-tools sidecar

Placeholder. Tiny Node HTTP server (Hono) in an `eclipse-temurin:17-jre` + Node 24 image wrapping the KoSIT
validator 1.6.3 (XRechnung config 2026-08-31) and Mustang CLI 2.26.0: `POST /validate/xml`, `POST /validate/pdf`,
`POST /visualize`, `GET /health` (02 §8). It is a pnpm workspace package (`services/*`): give it its own
`package.json` and `Dockerfile`.
