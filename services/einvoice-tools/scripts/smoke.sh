#!/usr/bin/env bash
# Smoke test against a RUNNING einvoice-tools instance (CI job `einvoice-tools`, or locally after
# `docker compose -f deploy/compose.dev.yml up einvoice-tools`). Uses the real validators, no fakes:
#   valid XRechnung UBL      → acceptable: true
#   invalid XRechnung UBL    → acceptable: false, BR-DE-15 among the errors
#   valid hybrid PDF         → valid: true, pdfaValid: true, xmlValid: true
#   PDF without XML          → valid: false
#
# Usage: services/einvoice-tools/scripts/smoke.sh [base-url]   (default http://127.0.0.1:8080)
set -euo pipefail

BASE="${1:-http://127.0.0.1:8080}"
FIX="$(cd "$(dirname "${BASH_SOURCE[0]}")/../test/fixtures" && pwd)"
fail=0

wait_healthy() {
  for _ in $(seq 1 90); do
    if curl -fsS "$BASE/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "✖ $BASE/health not healthy after 180 s" >&2
  curl -sS "$BASE/health" >&2 || true
  exit 1
}

check() { # name, file, endpoint, jq-assertion
  local name="$1" file="$2" endpoint="$3" assertion="$4" out
  out="$(curl -sS -X POST --data-binary "@$FIX/$file" "$BASE$endpoint")"
  if jq -e "$assertion" >/dev/null <<<"$out"; then
    echo "✔ $name"
  else
    echo "✖ $name — response: $(jq -c 'del(.reportXml)' <<<"$out" 2>/dev/null || echo "$out")" >&2
    fail=1
  fi
}

wait_healthy
curl -fsS "$BASE/health" | jq -c .

check "valid XRechnung UBL is acceptable" xrechnung-ubl-valid.xml /validate/xml \
  '.acceptable == true and (.errors | length) == 0 and .configVersion != null'
check "invalid XRechnung UBL is rejected with BR-DE-15" xrechnung-ubl-invalid.xml /validate/xml \
  '.acceptable == false and ([.errors[].code] | index("BR-DE-15")) != null'
check "valid hybrid ZUGFeRD/XRechnung PDF" zugferd-xrechnung-valid.pdf /validate/pdf \
  '.valid == true and .pdfaValid == true and .xmlValid == true'
check "PDF without embedded XML is invalid" pdf-without-xml.pdf /validate/pdf \
  '.valid == false and .xmlPresent == false'

if [[ $fail -ne 0 ]]; then
  echo "✖ smoke test failed" >&2
  exit 1
fi
echo "✔ einvoice-tools smoke test passed"
