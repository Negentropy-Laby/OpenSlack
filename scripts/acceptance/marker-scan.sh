#!/usr/bin/env bash
set -euo pipefail

: "${RUN_DESTRUCTIVE_ACCEPTANCE:?set RUN_DESTRUCTIVE_ACCEPTANCE=1 for the isolated drill}"
[[ "${RUN_DESTRUCTIVE_ACCEPTANCE}" == "1" ]] || { echo "RUN_DESTRUCTIVE_ACCEPTANCE must equal 1" >&2; exit 2; }
project="${COMPOSE_PROJECT_NAME:-rcwsman_b6_acceptance}"
[[ "${project}" == rcwsman_*_acceptance ]] || { echo "refusing non-acceptance project: ${project}" >&2; exit 2; }
app_port="${APP_PORT:-58080}"
db_container="${project}-db-1"
app_container="${project}-app-1"
marker="RC_WSMAN_RUNTIME_MARKER_$(date -u +%Y%m%dT%H%M%SZ)_$$"
encoded="$(printf '%s' "${marker}" | base64 -w0)"

response="$(curl -sS -X POST "http://127.0.0.1:${app_port}/v1/notifications" \
  -H 'Authorization: Bearer invalid.acceptance' -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: marker-scan' \
  --data "{\"vendor_id\":\"vendor-marker\",\"payload_base64\":\"${encoded}\"}")"
metrics="$(curl -fsS "http://127.0.0.1:${app_port}/metrics")"
logs="$(docker logs "${app_container}" 2>&1)"
attempt_audit="$(docker exec "${db_container}" psql -U rc_wsman -d rc_wsman -Atc \
  "SELECT COALESCE(string_agg(value,''),'') FROM (SELECT row_to_json(a)::text value FROM delivery_attempts a UNION ALL SELECT row_to_json(v)::text FROM admin_audit_events v) q")"
artifacts="$(find docs/testing -maxdepth 1 -type f -print0 | xargs -0 -r grep -h --binary-files=without-match -F "${marker}" || true)"
for surface in response metrics logs attempt_audit artifacts; do
  value="${!surface}"
  [[ "${value}" != *"${marker}"* ]] || { echo "marker leaked through ${surface}" >&2; exit 1; }
done

docker run --rm --network host \
  -e DATABASE_URL="postgres://rc_wsman:rc_wsman@127.0.0.1:${DB_PORT:-55432}/rc_wsman?sslmode=disable" \
  -v "$PWD:/src" -v "$PWD/.gomodcache:/go/pkg/mod" -w /src golang:1.26.5@sha256:3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647 \
  go test -race ./tests/integration -run '^TestSensitiveMarkerIsExcludedFromAttemptsAuditLogsAndOperatorProjections$' -count=1

marker_digest="$(printf '%s' "${marker}" | sha256sum | cut -d' ' -f1)"
printf 'MARKER_SCAN_PASS project=%s marker_sha256=%s surfaces=app_logs,metrics,api,attempts,audit,acceptance_artifacts,operator_projection,store_logs\n' \
  "${project}" "${marker_digest}"
