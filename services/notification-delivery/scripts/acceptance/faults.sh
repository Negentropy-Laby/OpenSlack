#!/usr/bin/env bash
set -euo pipefail

: "${RUN_DESTRUCTIVE_ACCEPTANCE:?set RUN_DESTRUCTIVE_ACCEPTANCE=1 for the isolated drill}"
[[ "${RUN_DESTRUCTIVE_ACCEPTANCE}" == "1" ]] || { echo "RUN_DESTRUCTIVE_ACCEPTANCE must equal 1" >&2; exit 2; }

project="${COMPOSE_PROJECT_NAME:-rcwsman_b6_acceptance}"
[[ "${project}" == rcwsman_*_acceptance ]] || { echo "refusing non-acceptance Compose project: ${project}" >&2; exit 2; }
db_port="${DB_PORT:-55432}"
app_port="${APP_PORT:-58080}"
prometheus_port="${PROMETHEUS_PORT:-59090}"
db_container="${project}-db-1"
app_container="${project}-app-1"
for container in "${db_container}" "${app_container}"; do
  [[ "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "${container}")" == "${project}" ]] || {
    echo "container ${container} is not owned by ${project}" >&2
    exit 2
  }
done

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
db_fixture="fault-db-$(date -u +%Y%m%dT%H%M%SZ)-$$"
docker run --rm --network host \
  -e DATABASE_URL="postgres://rc_wsman:rc_wsman@127.0.0.1:${db_port}/rc_wsman?sslmode=disable" \
  -v "$PWD:/src" -v "$PWD/.gomodcache:/go/pkg/mod" -w /src golang:1.26.5@sha256:3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647 \
  go test -race ./tests/integration \
    -run 'Test(CrashAfterSendBeforeCommitConvergesWithoutLossAndMayDuplicate|RecoveryAdvisoryLockAllowsOnlyOneActiveSweeper)$' \
    -count=1

# Seed one notification that becomes eligible while PostgreSQL is stopped.
# The vendor is disabled so the resumed worker terminates before any network I/O.
docker exec "${db_container}" psql -U rc_wsman -d rc_wsman -v ON_ERROR_STOP=1 -c "
  INSERT INTO vendors (vendor_id,owning_scope,lifecycle,record_revision,current_config_version,disabled_at,disabled_reason)
  VALUES ('vendor-demo','acceptance','disabled',1,1,clock_timestamp(),'fault drill no-network vendor')
  ON CONFLICT (vendor_id) DO UPDATE SET lifecycle='disabled',disabled_at=clock_timestamp(),disabled_reason='fault drill no-network vendor';
  INSERT INTO notifications (
    notification_id,caller_id,vendor_id,idempotency_key,request_fingerprint,payload_bytes,
    state,version,attempt_count,delivery_cycle_started_at,next_attempt_at
  ) VALUES (
    '${db_fixture}','${db_fixture}-caller','vendor-demo','${db_fixture}-key',
    digest('${db_fixture}-fingerprint','sha256'),convert_to('{}','UTF8'),
    'pending',1,0,clock_timestamp(),clock_timestamp()+interval '2 seconds'
  );
" >/dev/null

COMPOSE_PROJECT_NAME="${project}" DB_PORT="${db_port}" APP_PORT="${app_port}" PROMETHEUS_PORT="${prometheus_port}" \
  docker compose --env-file deploy/local.env.example stop db >/dev/null
down_code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${app_port}/health/ready" || true)"
[[ "${down_code}" == "503" ]] || { echo "readiness while PostgreSQL stopped was ${down_code}, want 503" >&2; exit 1; }
sleep 3
docker pause "${app_container}" >/dev/null
paused=1
trap 'if [[ "${paused:-0}" == "1" ]]; then docker unpause "${app_container}" >/dev/null 2>&1 || true; fi' EXIT

COMPOSE_PROJECT_NAME="${project}" DB_PORT="${db_port}" APP_PORT="${app_port}" PROMETHEUS_PORT="${prometheus_port}" \
  docker compose --env-file deploy/local.env.example start db >/dev/null
for _ in $(seq 1 30); do
  docker exec "${db_container}" pg_isready -U rc_wsman -d rc_wsman >/dev/null 2>&1 && break
  sleep 1
done
docker exec "${db_container}" pg_isready -U rc_wsman -d rc_wsman >/dev/null
pre_resume="$(docker exec "${db_container}" psql -U rc_wsman -d rc_wsman -AtF '|' -c "
  SELECT state,attempt_count,(SELECT count(*) FROM delivery_attempts a WHERE a.notification_id=n.notification_id)
  FROM notifications n WHERE notification_id='${db_fixture}'")"
[[ "${pre_resume}" == "pending|0|0" ]] || { echo "notification changed during database outage: ${pre_resume}" >&2; exit 1; }
docker unpause "${app_container}" >/dev/null
paused=0
trap - EXIT
recovered_code=""
for _ in $(seq 1 45); do
  recovered_code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${app_port}/health/ready" || true)"
  [[ "${recovered_code}" == "200" ]] && break
  sleep 1
done
[[ "${recovered_code}" == "200" ]] || { echo "readiness did not recover after PostgreSQL restart" >&2; exit 1; }
post_resume=""
for _ in $(seq 1 30); do
  post_resume="$(docker exec "${db_container}" psql -U rc_wsman -d rc_wsman -AtF '|' -c "
    SELECT state,attempt_count,COALESCE(dead_reason,''),
      (SELECT string_agg(event_kind,',' ORDER BY attempt_seq) FROM delivery_attempts a WHERE a.notification_id=n.notification_id)
    FROM notifications n WHERE notification_id='${db_fixture}'")"
  [[ "${post_resume}" == "dead|0|vendor_unavailable|claimed,outcome" ]] && break
  sleep 1
done
[[ "${post_resume}" == "dead|0|vendor_unavailable|claimed,outcome" ]] || { echo "notification did not resume after database recovery: ${post_resume}" >&2; exit 1; }

docker stop --timeout 15 "${app_container}" >/dev/null
app_exit="$(docker inspect -f '{{.State.ExitCode}}' "${app_container}")"
shutdown_tail="$(docker logs --tail 20 "${app_container}" 2>&1)"
[[ "${app_exit}" == "0" ]] || { echo "app shutdown exit=${app_exit}" >&2; exit 1; }
grep -q 'http_server_shutting_down' <<<"${shutdown_tail}"
grep -q 'server_stopped' <<<"${shutdown_tail}"
COMPOSE_PROJECT_NAME="${project}" DB_PORT="${db_port}" APP_PORT="${app_port}" PROMETHEUS_PORT="${prometheus_port}" \
  docker compose --env-file deploy/local.env.example start app >/dev/null
for _ in $(seq 1 30); do
  recovered_code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${app_port}/health/ready" || true)"
  [[ "${recovered_code}" == "200" ]] && break
  sleep 1
done
[[ "${recovered_code}" == "200" ]] || { echo "app did not return ready after bounded restart" >&2; exit 1; }

printf 'FAULT_DRILL_PASS started_at=%s project=%s crash_after_send=runner_process_exit_88 duplicate=allowed recovery_instances=2 db_down_readiness=%s db_outage_notification=%s db_recovered_readiness=%s db_resumed_notification=%s shutdown_exit=%s\n' \
  "${started_at}" "${project}" "${down_code}" "${pre_resume}" "${recovered_code}" "${post_resume}" "${app_exit}"
