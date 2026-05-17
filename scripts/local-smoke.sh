#!/usr/bin/env bash
set -euo pipefail

API_PORT="${API_PORT:-3127}"
API_TOKEN="${API_TOKEN:-local-dev-token}"
API_BASE="http://127.0.0.1:${API_PORT}"
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]] && kill -0 "${API_PID}" >/dev/null 2>&1; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

require_body_contains() {
  local body="$1"
  local needle="$2"
  if [[ "${body}" != *"${needle}"* ]]; then
    printf 'Expected response to contain %s, got:\n%s\n' "${needle}" "${body}" >&2
    exit 1
  fi
}

pnpm db:migrate

API_PORT="${API_PORT}" API_TOKEN="${API_TOKEN}" pnpm api >/tmp/job-search-api-smoke.log 2>&1 &
API_PID="$!"

for _ in {1..30}; do
  if curl -fsS "${API_BASE}/health" >/tmp/job-search-health.json; then
    break
  fi
  sleep 1
done

health="$(cat /tmp/job-search-health.json)"
require_body_contains "${health}" '"status":"ok"'

unauth_status="$(curl -sS -o /tmp/job-search-unauth.json -w '%{http_code}' "${API_BASE}/status")"
if [[ "${unauth_status}" != "401" ]]; then
  printf 'Expected /status without token to return 401, got %s\n' "${unauth_status}" >&2
  exit 1
fi

ingest="$(curl -fsS -H "Authorization: Bearer ${API_TOKEN}" -X POST "${API_BASE}/ingest/run")"
require_body_contains "${ingest}" '"normalized":4'

pipeline="$(curl -fsS -H "X-API-Token: ${API_TOKEN}" "${API_BASE}/pipeline")"
require_body_contains "${pipeline}" '"stats"'

for path in status digest providers profiles jobs applications manual-review audit metrics responses interviews; do
  curl -fsS -H "Authorization: Bearer ${API_TOKEN}" "${API_BASE}/${path}" >/dev/null
done

curl -fsS -H "Authorization: Bearer ${API_TOKEN}" "${API_BASE}/job/hh_hh-1001" >/dev/null
missing_status="$(curl -sS -H "Authorization: Bearer ${API_TOKEN}" -o /tmp/job-search-missing-job.json -w '%{http_code}' "${API_BASE}/job/missing")"
if [[ "${missing_status}" != "404" ]]; then
  printf 'Expected missing job to return 404, got %s\n' "${missing_status}" >&2
  exit 1
fi

pnpm worker:ingest >/dev/null
pnpm worker:apply >/dev/null
pnpm worker:inbox >/dev/null
pnpm worker:digest >/dev/null
pnpm worker:canary >/dev/null

printf 'Local smoke passed at %s\n' "${API_BASE}"
