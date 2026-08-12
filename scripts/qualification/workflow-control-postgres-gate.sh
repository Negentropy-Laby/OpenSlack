#!/usr/bin/env bash
set -euo pipefail

profile="${1:-}"
case "$profile" in
  gs9b-authority|gs9c-checkpoint) ;;
  *)
    echo "usage: workflow-control-postgres-gate.sh {gs9b-authority|gs9c-checkpoint}" >&2
    exit 2
    ;;
esac

: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"

readonly postgres_image='postgres:18.4@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
readonly profile_suffix="${profile%%-*}"
readonly postgres_container="openslack-${profile_suffix}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"

cleanup() {
  docker rm --force "$postgres_container" >/dev/null 2>&1 || true
}

wait_for_postgres() {
  for attempt in $(seq 1 60); do
    if docker exec "$postgres_container" pg_isready --username openslack --dbname openslack >/dev/null 2>&1; then
      return 0
    fi
    if [ "$attempt" -eq 60 ]; then
      docker logs "$postgres_container"
      return 1
    fi
    sleep 1
  done
}

refresh_database_url() {
  local published postgres_port
  published="$(docker port "$postgres_container" 5432/tcp)"
  postgres_port="${published##*:}"
  test "$postgres_port" -ge 1
  export DATABASE_URL="postgres://openslack:openslack@127.0.0.1:${postgres_port}/openslack?sslmode=disable"
}

trap cleanup EXIT
cleanup
docker run --detach \
  --name "$postgres_container" \
  --env POSTGRES_USER=openslack \
  --env POSTGRES_PASSWORD=openslack \
  --env POSTGRES_DB=openslack \
  --publish 127.0.0.1::5432 \
  "$postgres_image" >/dev/null
wait_for_postgres
refresh_database_url
export GOWORK=off
cd "$GITHUB_WORKSPACE/services/workflow-control"

case "$profile" in
  gs9b-authority)
    export WORKFLOW_CONTROL_AUTHORITY_MODE=local-qualification-v1
    export WORKFLOW_CONTROL_AUTHORITY_HTTP_BIND=127.0.0.1:8082
    export WORKFLOW_CONTROL_AUTHORITY_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    export WORKFLOW_CONTROL_AUTHORITY_BEARER_TOKEN_SHA256=047ec1226bb42811637335e29130c659653eca181acad0015ae3fbe35c6d379d
    export WORKFLOW_CONTROL_AUTHORITY_WORKSPACE_ID=workspace.demo
    export WORKFLOW_CONTROL_AUTHORITY_CALLER_ID=typescript:workflow-control-qualification
    export WORKFLOW_CONTROL_AUTHORITY_ROUTING_EPOCH=9
    go test -race ./internal/authorityapp ./internal/authoritystore/... ./internal/config ./tests/contracts ./tests/integration -count=1
    WORKFLOW_CONTROL_GS9B_QUALIFICATION=1 go test -race ./cmd/authority-server -run '^TestGS9BQualification$' -count=1
    restart_schema="workflow_control_gs9b_restart_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT}"
    WORKFLOW_CONTROL_GS9B_RESTART_PHASE=seed WORKFLOW_CONTROL_GS9B_RESTART_SCHEMA="$restart_schema" \
      go test -race ./cmd/authority-server -run '^TestGS9BRestartQualification$' -count=1
    ;;
  gs9c-checkpoint)
    export WORKFLOW_CONTROL_CHECKPOINT_SHADOW_MODE=local-qualification-v1
    export WORKFLOW_CONTROL_CHECKPOINT_SHADOW_HTTP_BIND=127.0.0.1:8083
    export WORKFLOW_CONTROL_CHECKPOINT_SHADOW_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    export WORKFLOW_CONTROL_CHECKPOINT_SHADOW_BEARER_TOKEN_SHA256=047ec1226bb42811637335e29130c659653eca181acad0015ae3fbe35c6d379d
    export WORKFLOW_CONTROL_CHECKPOINT_SHADOW_WORKSPACE_ID=workspace.demo
    export WORKFLOW_CONTROL_CHECKPOINT_SHADOW_CALLER_ID=typescript:workflow-checkpoint-shadow
    go test -race ./internal/checkpointshadowapp ./internal/checkpointshadowstore/... ./internal/config ./tests/contracts ./tests/integration -count=1
    WORKFLOW_CONTROL_GS9C_QUALIFICATION=1 go test -race ./cmd/checkpoint-shadow-server -run '^TestGS9CQualification$' -count=1
    restart_schema="workflow_control_gs9c_restart_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT}"
    WORKFLOW_CONTROL_GS9C_RESTART_PHASE=seed WORKFLOW_CONTROL_GS9C_RESTART_SCHEMA="$restart_schema" \
      go test -race ./cmd/checkpoint-shadow-server -run '^TestGS9CRestartQualification$' -count=1
    ;;
esac

docker restart "$postgres_container" >/dev/null
wait_for_postgres
refresh_database_url

case "$profile" in
  gs9b-authority)
    WORKFLOW_CONTROL_GS9B_RESTART_PHASE=verify WORKFLOW_CONTROL_GS9B_RESTART_SCHEMA="$restart_schema" \
      go test -race ./cmd/authority-server -run '^TestGS9BRestartQualification$' -count=1
    ;;
  gs9c-checkpoint)
    WORKFLOW_CONTROL_GS9C_RESTART_PHASE=verify WORKFLOW_CONTROL_GS9C_RESTART_SCHEMA="$restart_schema" \
      go test -race ./cmd/checkpoint-shadow-server -run '^TestGS9CRestartQualification$' -count=1
    ;;
esac
