#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'CANARY_PREFLIGHT_FAIL code=%s\n' "$1" >&2
  exit 2
}

usage() {
  printf 'usage: %s --env-file <mode-0600-path>\n' "$0" >&2
  exit 2
}

[[ "$#" -eq 2 && "$1" == "--env-file" ]] || usage
env_file="$2"
[[ -f "${env_file}" && ! -L "${env_file}" ]] || fail env_file_not_regular

file_mode=""
file_owner=""
if file_mode="$(stat -c '%a' "${env_file}" 2>/dev/null)"; then
  file_owner="$(stat -c '%u' "${env_file}" 2>/dev/null)" || fail env_file_stat
else
  file_mode="$(stat -f '%Lp' "${env_file}" 2>/dev/null)" || fail env_file_stat
  file_owner="$(stat -f '%u' "${env_file}" 2>/dev/null)" || fail env_file_stat
fi
[[ "${file_mode}" == "600" ]] || fail env_file_mode
[[ "${file_owner}" == "$(id -u)" ]] || fail env_file_owner

declare -A allowed=()
for key in \
  CANARY_DEPLOYMENT_MODE \
  NOTIFICATION_SERVICE_IMAGE \
  CANARY_WEBHOOK_RECEIVER_IMAGE \
  NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST \
  CANARY_SOURCE_COMMIT \
  CANARY_SOURCE_TREE \
  API_KEY_PEPPER_ACTIVE \
  API_KEY_PEPPER_PREVIOUS \
  CANARY_SLACK_BOT_TOKEN \
  WEBHOOK_AUDIT_TOKEN \
  CANARY_VENDOR_SLACK \
  CANARY_VENDOR_WEBHOOK \
  CANARY_POSTGRES_USER \
  CANARY_POSTGRES_PASSWORD \
  CANARY_POSTGRES_DB \
  CANARY_DATABASE_URL \
  CANARY_SERVICE_ORIGIN \
  CANARY_WEBHOOK_ORIGIN \
  DB_PORT \
  APP_PORT \
  PROMETHEUS_PORT \
  WEBHOOK_RECEIVER_PORT \
  WEBHOOK_RECEIVER_EVIDENCE_DIR
do
  allowed["${key}"]=1
done

declare -A values=()
while IFS= read -r line || [[ -n "${line}" ]]; do
  [[ "${line}" != *$'\r'* ]] || fail env_file_crlf
  [[ -z "${line}" || "${line}" =~ ^[[:space:]]*# ]] && continue
  [[ "${line}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || fail env_file_syntax
  key="${BASH_REMATCH[1]}"
  value="${BASH_REMATCH[2]}"
  [[ -n "${allowed[${key}]:-}" ]] || fail env_file_unknown_key
  [[ -z "${values[${key}]+x}" ]] || fail env_file_duplicate_key
  values["${key}"]="${value}"
done <"${env_file}"

require_value() {
  local key="$1"
  local value="${values[${key}]:-}"
  [[ -n "${value}" ]] || fail "missing_${key}"
  [[ ! "${value}" =~ ^\<[^[:cntrl:]]+\>$ ]] || fail "placeholder_${key}"
  [[ "${value}" != "CHANGE_ME" && "${value}" != "changeme" ]] || fail "placeholder_${key}"
}

for key in \
  CANARY_DEPLOYMENT_MODE \
  NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST \
  API_KEY_PEPPER_ACTIVE \
  CANARY_SLACK_BOT_TOKEN \
  WEBHOOK_AUDIT_TOKEN \
  CANARY_VENDOR_SLACK \
  CANARY_VENDOR_WEBHOOK \
  CANARY_POSTGRES_USER \
  CANARY_POSTGRES_PASSWORD \
  CANARY_POSTGRES_DB \
  CANARY_DATABASE_URL \
  CANARY_SERVICE_ORIGIN \
  CANARY_WEBHOOK_ORIGIN \
  WEBHOOK_RECEIVER_EVIDENCE_DIR
do
  require_value "${key}"
done

deployment_digest="${values[NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST]}"
[[ "${deployment_digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || fail deployment_digest_format
[[ "${values[CANARY_POSTGRES_USER]}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail database_user_format
[[ "${values[CANARY_POSTGRES_DB]}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail database_name_format
[[ "${values[CANARY_POSTGRES_PASSWORD]}" =~ ^[A-Za-z0-9_-]{32,128}$ ]] || fail database_password_format

expected_database_url="postgres://${values[CANARY_POSTGRES_USER]}:${values[CANARY_POSTGRES_PASSWORD]}@db:5432/${values[CANARY_POSTGRES_DB]}?sslmode=disable"
[[ "${values[CANARY_DATABASE_URL]}" == "${expected_database_url}" ]] || fail database_url_mismatch

validate_origin() {
  local key="$1"
  local origin="${values[${key}]}"
  [[ "${origin}" =~ ^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{1,62}(:443)?/?$ ]] ||
    fail "invalid_${key}"
}
validate_origin CANARY_SERVICE_ORIGIN
validate_origin CANARY_WEBHOOK_ORIGIN

for key in DB_PORT APP_PORT PROMETHEUS_PORT WEBHOOK_RECEIVER_PORT; do
  if [[ -n "${values[${key}]:-}" ]]; then
    [[ "${values[${key}]}" =~ ^[0-9]{1,5}$ ]] || fail "invalid_${key}"
    (( values[${key}] >= 1 && values[${key}] <= 65535 )) || fail "invalid_${key}"
  fi
done

evidence_dir="${values[WEBHOOK_RECEIVER_EVIDENCE_DIR]}"
[[ "${evidence_dir}" == /* && "${evidence_dir}" != "/" && "${evidence_dir}" != "/root" && "${evidence_dir}" != "/home" ]] ||
  fail evidence_directory_path

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
compose_files=(
  -f "${repo_root}/docker-compose.yml"
  -f "${repo_root}/deploy/canary/docker-compose.yml"
)

case "${values[CANARY_DEPLOYMENT_MODE]}" in
  pinned-image)
    require_value NOTIFICATION_SERVICE_IMAGE
    require_value CANARY_WEBHOOK_RECEIVER_IMAGE
    service_image="${values[NOTIFICATION_SERVICE_IMAGE]}"
    receiver_image="${values[CANARY_WEBHOOK_RECEIVER_IMAGE]}"
    [[ "${service_image}" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || fail service_image_not_digest_pinned
    [[ "${receiver_image}" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || fail receiver_image_not_digest_pinned
    [[ "${service_image##*@}" == "${deployment_digest}" ]] || fail service_image_digest_mismatch
    [[ -z "${values[CANARY_SOURCE_COMMIT]:-}${values[CANARY_SOURCE_TREE]:-}" ]] ||
      fail mixed_image_modes
    compose_files+=(-f "${repo_root}/deploy/canary/docker-compose.pinned.yml")
    ;;
  verified-local-build)
    require_value CANARY_SOURCE_COMMIT
    require_value CANARY_SOURCE_TREE
    [[ -z "${values[NOTIFICATION_SERVICE_IMAGE]:-}${values[CANARY_WEBHOOK_RECEIVER_IMAGE]:-}" ]] ||
      fail mixed_image_modes
    source_commit="${values[CANARY_SOURCE_COMMIT]}"
    source_tree="${values[CANARY_SOURCE_TREE]}"
    [[ "${source_commit}" =~ ^[0-9a-f]{40}$ ]] || fail source_commit_format
    [[ "${source_tree}" =~ ^[0-9a-f]{40}$ ]] || fail source_tree_format
    actual_commit="$(git -C "${repo_root}" rev-parse HEAD 2>/dev/null)" || fail source_commit_unavailable
    actual_tree="$(git -C "${repo_root}" rev-parse HEAD^{tree} 2>/dev/null)" || fail source_tree_unavailable
    [[ "${actual_commit}" == "${source_commit}" ]] || fail source_commit_mismatch
    [[ "${actual_tree}" == "${source_tree}" ]] || fail source_tree_mismatch
    [[ -z "$(git -C "${repo_root}" status --porcelain=v1 --untracked-files=all 2>/dev/null)" ]] ||
      fail source_worktree_dirty
    expected_local_digest="$(
      printf 'rc_wsman.canary.local-build.v1\0%s\0%s' "${source_commit}" "${source_tree}" |
        sha256sum | cut -d' ' -f1
    )"
    [[ "${deployment_digest}" == "sha256:${expected_local_digest}" ]] || fail local_deployment_digest_mismatch
    compose_files+=(-f "${repo_root}/deploy/canary/docker-compose.local-build.yml")
    ;;
  *)
    fail deployment_mode
    ;;
esac

docker compose --env-file "${env_file}" "${compose_files[@]}" config --quiet >/dev/null 2>&1 ||
  fail compose_config_invalid

printf 'CANARY_PREFLIGHT_PASS mode=%s env_file_mode=0600 compose=valid\n' \
  "${values[CANARY_DEPLOYMENT_MODE]}"
