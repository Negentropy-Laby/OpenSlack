#!/usr/bin/env bash

set -euo pipefail
IFS=$'\n\t'

readonly GO_VERSION="1.26.5"
readonly GO_IMAGE="golang:1.26.5@sha256:3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647"
readonly POSTGRES_IMAGE="postgres:18.4@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a"
readonly PROMETHEUS_IMAGE="prom/prometheus:v3.13.1@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893"
readonly MOD_CACHE_VOLUME="openslack-go-check-mod-go1-26-5-3aff6657219a"
readonly BUILD_CACHE_VOLUME="openslack-go-check-build-go1-26-5-3aff6657219a"

script_dir="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd -P)"
repo_root="$(cd -- "${script_dir}/.." && pwd -P)"

load_workflow_budget_qualification_fixture() {
  local fixture="${repo_root}/services/workflow-control/testdata/gs9e-qualification.conf"
  local count key
  local -a keys=(
    WORKFLOW_CONTROL_BUDGET_AUTHORITY_SERVICE_BUILD_SHA
    WORKFLOW_CONTROL_BUDGET_AUTHORITY_BEARER_TOKEN_SHA256
    WORKFLOW_CONTROL_BUDGET_AUTHORITY_WORKSPACE_ID
    WORKFLOW_CONTROL_BUDGET_AUTHORITY_CALLER_ID
    WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH
    WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH
    WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS
    WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD
    WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS
  )
  [[ -f "${fixture}" ]] || fail "Workflow Control GS9-E qualification fixture is missing"
  [[ "$(grep -Ec '^[^[:space:]]' "${fixture}")" -eq "${#keys[@]}" ]] || fail "Workflow Control GS9-E qualification fixture contains unexpected entries"
  count="$(grep -Ec '^[A-Z0-9_]+=[A-Za-z0-9:._-]+$' "${fixture}")"
  [[ "${count}" -eq "${#keys[@]}" ]] || fail "Workflow Control GS9-E qualification fixture is not closed"
  for key in "${keys[@]}"; do
    [[ "$(grep -Ec "^${key}=" "${fixture}")" -eq 1 ]] || fail "Workflow Control GS9-E qualification fixture key drifted: ${key}"
  done
  set -a
  # shellcheck disable=SC1090 -- the path and closed keys are validated above.
  source "${fixture}"
  set +a
}
readonly script_dir repo_root
readonly workspace_file="${repo_root}/go.work"
readonly workspace_parser="${repo_root}/scripts/go-check/parse-work-json.go"
readonly workspace_parser_test="${repo_root}/scripts/go-check/parse-work-json_test.go"
readonly container_gate="${repo_root}/scripts/go-check/container-gate.sh"
readonly service_config_root="${repo_root}/scripts/go-check/services"

host_runtime=""
docker_client_os=""
staged_repository_dir=""
staged_module_dir=""
active_child_pid=""
declare -a workspace_modules=()
declare -a cleanup_containers=()
declare -a cleanup_networks=()
declare -a cleanup_network_owners=()
declare -a cleanup_volumes=()
declare -a cleanup_images=()
declare -a cleanup_directories=()
declare -a cleanup_files=()

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/go-check.sh services/<name>
  scripts/go-check.sh --all
EOF
}

fail() {
  printf 'go-check: %s\n' "$*" >&2
  exit 1
}

log() {
  printf 'go-check: %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

docker_cmd() {
  if [[ "${host_runtime}" == "git-bash" ]]; then
    MSYS_NO_PATHCONV=1 docker "$@"
  else
    docker "$@"
  fi
}

docker_cmd_interruptible() {
  if [[ "${host_runtime}" == "git-bash" ]]; then
    run_interruptible env MSYS_NO_PATHCONV=1 docker "$@"
  else
    run_interruptible docker "$@"
  fi
}

run_interruptible() {
  local status
  "$@" &
  active_child_pid=$!
  if wait "${active_child_pid}"; then
    status=0
  else
    status=$?
  fi
  active_child_pid=""
  return "${status}"
}

resource_owned() {
  local kind="$1"
  local resource="$2"
  local expected_owner="$3"
  local format observed
  case "${kind}" in
    container | image)
      format='{{ index .Config.Labels "com.openslack.go-check.run" }}'
      ;;
    network | volume)
      format='{{ index .Labels "com.openslack.go-check.run" }}'
      ;;
    *)
      return 1
      ;;
  esac
  case "${kind}" in
    container)
      observed="$(docker_cmd inspect --format "${format}" "${resource}" 2>/dev/null)" || return 1
      ;;
    image)
      observed="$(docker_cmd image inspect --format "${format}" "${resource}" 2>/dev/null)" ||
        return 1
      ;;
    network)
      observed="$(docker_cmd network inspect --format "${format}" "${resource}" 2>/dev/null)" ||
        return 1
      ;;
    volume)
      observed="$(docker_cmd volume inspect --format "${format}" "${resource}" 2>/dev/null)" ||
        return 1
      ;;
  esac
  observed="${observed%$'\r'}"
  [[ "${observed}" == "${expected_owner}" ]]
}

require_resource_owned() {
  local kind="$1"
  local resource="$2"
  local expected_owner="$3"
  resource_owned "${kind}" "${resource}" "${expected_owner}" ||
    fail "${kind} ownership verification failed: ${resource}"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  local item owner resource network_ids network_id
  for item in "${cleanup_containers[@]}"; do
    owner="${item%%|*}"
    resource="${item#*|}"
    if resource_owned container "${resource}" "${owner}"; then
      docker_cmd rm -f "${resource}" >/dev/null 2>&1 || true
    fi
  done
  for item in "${cleanup_networks[@]}"; do
    owner="${item%%|*}"
    resource="${item#*|}"
    if resource_owned network "${resource}" "${owner}"; then
      docker_cmd network rm "${resource}" >/dev/null 2>&1 || true
    fi
  done
  for owner in "${cleanup_network_owners[@]}"; do
    network_ids="$(
      docker_cmd network ls \
        --filter "label=com.openslack.go-check.run=${owner}" \
        --format '{{.ID}}' 2>/dev/null || true
    )"
    while IFS= read -r network_id; do
      [[ -n "${network_id}" ]] &&
        docker_cmd network rm "${network_id}" >/dev/null 2>&1 || true
    done <<<"${network_ids}"
  done
  for item in "${cleanup_volumes[@]}"; do
    owner="${item%%|*}"
    resource="${item#*|}"
    if resource_owned volume "${resource}" "${owner}"; then
      docker_cmd volume rm -f "${resource}" >/dev/null 2>&1 || true
    fi
  done
  for item in "${cleanup_images[@]}"; do
    owner="${item%%|*}"
    resource="${item#*|}"
    if resource_owned image "${resource}" "${owner}"; then
      docker_cmd image rm -f "${resource}" >/dev/null 2>&1 || true
    fi
  done
  for item in "${cleanup_directories[@]}"; do
    [[ -n "${item}" && -d "${item}" ]] && rm -rf -- "${item}"
  done
  for item in "${cleanup_files[@]}"; do
    [[ -n "${item}" && -f "${item}" ]] && rm -f -- "${item}"
  done

  exit "${status}"
}

handle_signal() {
  local signal="$1"
  local status="$2"
  trap - INT TERM
  if [[ -n "${active_child_pid}" ]]; then
    kill "-${signal}" "${active_child_pid}" >/dev/null 2>&1 || true
    wait "${active_child_pid}" >/dev/null 2>&1 || true
    active_child_pid=""
  fi
  exit "${status}"
}

trap cleanup EXIT
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM

detect_host_runtime() {
  local system release
  system="$(uname -s)"
  release="$(uname -r)"
  case "${system}" in
    MINGW* | MSYS* | CYGWIN*)
      host_runtime="git-bash"
      ;;
    Linux)
      if [[ "${release}" =~ [Mm]icrosoft ]]; then
        host_runtime="wsl"
      else
        host_runtime="linux"
      fi
      ;;
    *)
      fail "unsupported host runtime: ${system}"
      ;;
  esac
}

docker_path() {
  local source_path="$1"
  case "${host_runtime}" in
    git-bash)
      require_command cygpath
      cygpath -aw "${source_path}"
      ;;
    wsl)
      if [[ "${docker_client_os}" == "windows" ]]; then
        require_command wslpath
        wslpath -w "${source_path}"
      else
        printf '%s\n' "${source_path}"
      fi
      ;;
    linux)
      printf '%s\n' "${source_path}"
      ;;
    *)
      fail "host runtime was not initialized"
      ;;
  esac
}

preflight_repository() {
  require_command git
  require_command find
  require_command sort
  require_command uname
  require_command date
  require_command grep
  require_command sleep
  require_command mktemp
  require_command rm
  require_command tar

  [[ -f "${workspace_file}" && ! -L "${workspace_file}" ]] ||
    fail "root go.work must be a regular non-symlink file"
  [[ -f "${workspace_parser}" && ! -L "${workspace_parser}" ]] ||
    fail "workspace parser must be a regular non-symlink file"
  [[ -f "${workspace_parser_test}" && ! -L "${workspace_parser_test}" ]] ||
    fail "workspace parser tests must be a regular non-symlink file"
  [[ -f "${container_gate}" && ! -L "${container_gate}" ]] ||
    fail "container gate must be a regular non-symlink file"
  [[ -d "${service_config_root}" && ! -L "${service_config_root}" ]] ||
    fail "service verification config root must be a regular non-symlink directory"
  [[ ! -e "${repo_root}/go.mod" ]] || fail "a root go.mod is forbidden"

  local observed_root
  observed_root="$(git -C "${repo_root}" rev-parse --show-toplevel)"
  [[ "$(cd -- "${observed_root}" && pwd -P)" == "${repo_root}" ]] ||
    fail "script must run inside the repository that owns go.work"
}

preflight_docker() {
  require_command docker
  docker_cmd_interruptible info >/dev/null 2>&1 ||
    fail "Docker daemon is unavailable; enable a supported Docker runtime"

  docker_client_os="$(docker_cmd version --format '{{.Client.Os}}')"
  docker_client_os="${docker_client_os%$'\r'}"
  case "${docker_client_os}" in
    linux | windows) ;;
    *) fail "unsupported Docker client OS: ${docker_client_os}" ;;
  esac

  require_image "${GO_IMAGE}"
  docker_cmd_interruptible volume create "${MOD_CACHE_VOLUME}" >/dev/null
  docker_cmd_interruptible volume create "${BUILD_CACHE_VOLUME}" >/dev/null

  local observed_go_version version_output
  version_output="$(mktemp -t openslack-go-check-version.XXXXXX)"
  cleanup_files+=("${version_output}")
  docker_cmd_interruptible run --rm --pull=never \
      --env GOTOOLCHAIN=local \
      --env GOWORK=off \
      "${GO_IMAGE}" \
      sh -ceu 'test "$(go env GOWORK)" = "off"; go env GOVERSION' >"${version_output}"
  observed_go_version="$(<"${version_output}")"
  observed_go_version="${observed_go_version%$'\r'}"
  rm -f -- "${version_output}"
  [[ "${observed_go_version}" == "go${GO_VERSION}" ]] ||
    fail "pinned image reported ${observed_go_version}; expected go${GO_VERSION}"
}

require_image() {
  local image="$1"
  docker_cmd image inspect "${image}" >/dev/null 2>&1 ||
    fail "required pinned image is missing; run: docker pull ${image}"
}

load_workspace_modules() {
  local workspace_mount parser_mount
  workspace_mount="$(docker_path "${workspace_file}")"
  parser_mount="$(docker_path "${workspace_parser}")"

  local parser_output parser_output_file
  parser_output_file="$(mktemp -t openslack-go-check-workspace.XXXXXX)"
  cleanup_files+=("${parser_output_file}")
  if ! docker_cmd_interruptible run --rm --pull=never \
      --env GOTOOLCHAIN=local \
      --env GOWORK=off \
      --mount "type=bind,source=${workspace_mount},target=/input/go.work,readonly" \
      --mount "type=bind,source=${parser_mount},target=/input/parse-work-json.go,readonly" \
      --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod" \
      --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build" \
      "${GO_IMAGE}" \
      sh -ceu \
      'test "$(go env GOWORK)" = "off"
       go work edit -json /input/go.work > /tmp/go-work.json
       go run /input/parse-work-json.go < /tmp/go-work.json' >"${parser_output_file}"; then
    fail "could not parse go.work with the pinned Go toolchain"
  fi
  parser_output="$(<"${parser_output_file}")"
  rm -f -- "${parser_output_file}"
  workspace_modules=()
  local parsed_module
  while IFS= read -r parsed_module; do
    parsed_module="${parsed_module%$'\r'}"
    [[ -n "${parsed_module}" ]] && workspace_modules+=("${parsed_module}")
  done <<<"${parser_output}"
  ((${#workspace_modules[@]} > 0)) || fail "go.work contains no reviewed service modules"

  local module
  for module in "${workspace_modules[@]}"; do
    validate_module_path "${module#./}"
  done

  compare_workspace_to_repository
}

compare_workspace_to_repository() {
  local -a discovered=()
  local manifest relative manifest_list
  manifest_list="$(mktemp -t openslack-go-check-manifests.XXXXXX)"
  cleanup_files+=("${manifest_list}")
  find "${repo_root}/services" -mindepth 2 -maxdepth 2 -name go.mod -print0 >"${manifest_list}"
  sort -z "${manifest_list}" -o "${manifest_list}"
  while IFS= read -r -d '' manifest; do
    [[ -f "${manifest}" && ! -L "${manifest}" ]] ||
      fail "service module manifest must be a regular non-symlink file"
    relative="${manifest#"${repo_root}/"}"
    discovered+=("./${relative%/go.mod}")
  done <"${manifest_list}"
  rm -f -- "${manifest_list}"

  ((${#discovered[@]} == ${#workspace_modules[@]})) ||
    fail "go.work must list every and only repository service module"

  local index
  for ((index = 0; index < ${#discovered[@]}; index++)); do
    [[ "${discovered[index]}" == "${workspace_modules[index]}" ]] ||
      fail "go.work module set differs from repository service modules"
  done
}

validate_module_path() {
  local module="$1"
  [[ "${module}" =~ ^services/[a-z0-9][a-z0-9-]{0,47}$ ]] ||
    fail "module path must match services/<name>: ${module}"

  local module_dir="${repo_root}/${module}"
  [[ -d "${module_dir}" && ! -L "${module_dir}" ]] ||
    fail "module directory must be a regular non-symlink directory: ${module}"
  [[ -f "${module_dir}/go.mod" && ! -L "${module_dir}/go.mod" ]] ||
    fail "module is missing a regular go.mod: ${module}"
  [[ -f "${module_dir}/go.sum" && ! -L "${module_dir}/go.sum" ]] ||
    fail "module is missing a regular go.sum: ${module}"

  local dirty
  dirty="$(git -C "${repo_root}" status --porcelain=v1 --untracked-files=all -- "${module}")"
  [[ -z "${dirty}" ]] || fail "module source must match the exact committed HEAD: ${module}"

  local tracked_index tracked_paths tracked_path tracked_name
  tracked_index="$(mktemp -t openslack-go-check-index.XXXXXX)"
  cleanup_files+=("${tracked_index}")
  git -C "${repo_root}" ls-files -s -- "${module}" >"${tracked_index}"
  if grep -q '^120000 ' "${tracked_index}"; then
    fail "module contains a tracked symbolic link: ${module}"
  fi
  rm -f -- "${tracked_index}"

  tracked_paths="$(mktemp -t openslack-go-check-paths.XXXXXX)"
  cleanup_files+=("${tracked_paths}")
  git -C "${repo_root}" ls-files -z -- "${module}" >"${tracked_paths}"
  while IFS= read -r -d '' tracked_path; do
    tracked_name="${tracked_path##*/}"
    case "/${tracked_path}/" in
      */.git/* | */.openslack.local/* | */secrets/* | */credentials/*)
        fail "module contains a forbidden tracked credential path: ${module}"
        ;;
    esac
    case "${tracked_name}" in
      .env | .env.* | *.pem | *.key | *.p12 | *.pfx | credentials.json)
        fail "module contains forbidden credential material tracked in Git: ${module}"
        ;;
    esac
  done <"${tracked_paths}"
  rm -f -- "${tracked_paths}"
}

module_in_workspace() {
  local requested="./$1"
  local module
  for module in "${workspace_modules[@]}"; do
    [[ "${module}" == "${requested}" ]] && return 0
  done
  return 1
}

read_service_config() {
  local module_slug="$1"
  local -n capabilities_ref="$2"
  local -n docker_target_ref="$3"
  local -n runtime_profile_ref="$4"
  local config_path="${service_config_root}/${module_slug}.conf"

  [[ -f "${config_path}" && ! -L "${config_path}" ]] ||
    fail "module is missing its reviewed verification config: services/${module_slug}"

  local line1 line2 line3 extra
  {
    IFS= read -r line1
    IFS= read -r line2
    IFS= read -r line3
    if IFS= read -r extra; then
      fail "service verification config must contain exactly three lines: ${module_slug}"
    fi
  } <"${config_path}"

  [[ "${line1}" == capabilities=* && "${line2}" == docker_target=* &&
    "${line3}" == runtime_profile=* ]] ||
    fail "service verification config has invalid field order: ${module_slug}"

  capabilities_ref="${line1#capabilities=}"
  docker_target_ref="${line2#docker_target=}"
  runtime_profile_ref="${line3#runtime_profile=}"

  if [[ "${capabilities_ref}" != "pure" ]]; then
    local previous_capability="" capability
    local -a configured_capabilities=()
    IFS=',' read -r -a configured_capabilities <<<"${capabilities_ref}"
    ((${#configured_capabilities[@]} > 0)) ||
      fail "service verification capabilities cannot be empty: ${module_slug}"
    for capability in "${configured_capabilities[@]}"; do
      case "${capability}" in
        database | distribution | http-openapi | prometheus | worker) ;;
        *) fail "service verification capability is unknown: ${module_slug}" ;;
      esac
      [[ -z "${previous_capability}" || "${previous_capability}" < "${capability}" ]] ||
        fail "service verification capabilities are duplicate or not sorted: ${module_slug}"
      previous_capability="${capability}"
    done
  fi
  [[ "${docker_target_ref}" == "none" ||
    "${docker_target_ref}" =~ ^[a-z0-9][a-z0-9._-]{0,47}$ ]] ||
    fail "service verification Docker target is invalid: ${module_slug}"
  case "${runtime_profile_ref}" in
    none | governance-control-v1 | governance-control-v2 | notification-delivery-v1 | organization-graph-v1 | workflow-control-shadow-v1 | workflow-control-runner-v1 | workflow-control-authority-v2 | workflow-control-checkpoint-shadow-v1 | workflow-control-effect-shadow-v1 | workflow-control-budget-authority-v1) ;;
    *) fail "service verification runtime profile is unknown: ${module_slug}" ;;
  esac
}

has_capability() {
  local capabilities="$1"
  local capability="$2"
  [[ ",${capabilities}," == *",${capability},"* ]]
}

validate_dockerignore() {
  local dockerignore="$1"
  local line first_rule_seen=0
  if LC_ALL=C grep -q $'[^\t -~]' "${dockerignore}"; then
    fail "distribution .dockerignore contains non-ASCII or control characters"
  fi
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "${line}" || "${line}" =~ ^[[:space:]]*# ]] && continue
    if ((first_rule_seen == 0)); then
      [[ "${line}" == "**" ]] ||
        fail "distribution .dockerignore must begin with a deny-all rule"
      first_rule_seen=1
      continue
    fi
    case "${line}" in
      '!Dockerfile' | \
      '!.dockerignore' | \
      '!audit.go' | \
      '!contract.go' | \
      '!go.mod' | \
      '!go.sum' | \
      '!governancecontrol.go' | \
      '!organizationgraph.go' | \
      '!shadow_contract.go' | \
      '!workflowcontrol.go' | \
      '!authoritycontract/' | \
      '!authoritycontract/*.go' | \
      '!authoritycontract/generated/' | \
      '!authoritycontract/generated/v2/' | \
      '!authoritycontract/generated/v2/*.json' | \
      '!authoritycontract/generated/v2/schemas/' | \
      '!authoritycontract/generated/v2/schemas/*.json' | \
      '!budgetcontract/' | \
      '!budgetcontract/*.go' | \
      '!budgetcontract/generated/' | \
      '!budgetcontract/generated/v1/' | \
      '!budgetcontract/generated/v1/*.json' | \
      '!budgetcontract/generated/v1/schemas/' | \
      '!budgetcontract/generated/v1/schemas/*.json' | \
      '!LICENSE' | \
      '!NOTICE' | \
      '!THIRD_PARTY_NOTICES.md' | \
      '!SBOM.cdx.json' | \
      '!cmd/' | \
      '!cmd/**/' | \
      '!cmd/**/*.go' | \
      '!integration/' | \
      '!integration/source-manifest.v2.json' | \
      '!integration/schemas/' | \
      '!integration/schemas/source-manifest.v2.schema.json' | \
      '!internal/' | \
      '!internal/**/' | \
      '!internal/**/*.go' | \
      '!runnerprotocol/' | \
      '!runnerprotocol/*.go' | \
      '!migrations/' | \
      '!migrations/*.sql')
        ;;
      !*) fail "distribution .dockerignore contains an unreviewed allow rule: ${line}" ;;
      *) ;;
    esac
  done <"${dockerignore}"
  ((first_rule_seen == 1)) || fail "distribution .dockerignore contains no rules"
}

detect_capabilities() {
  local module_dir="$1"
  local module_slug="$2"
  local -n db_ref="$3"
  local -n http_ref="$4"
  local -n prometheus_ref="$5"
  local -n distribution_ref="$6"
  local -n worker_ref="$7"
  local -n docker_target_ref="$8"
  local -n runtime_profile_ref="$9"

  db_ref=0
  http_ref=0
  prometheus_ref=0
  distribution_ref=0
  worker_ref=0

  local capabilities configured_docker_target configured_runtime_profile
  read_service_config \
    "${module_slug}" \
    capabilities \
    configured_docker_target \
    configured_runtime_profile
  docker_target_ref="${configured_docker_target}"
  runtime_profile_ref="${configured_runtime_profile}"

  if [[ "${capabilities}" == "pure" ]]; then
    [[ "${docker_target_ref}" == "none" && "${runtime_profile_ref}" == "none" ]] ||
      fail "a pure module cannot declare a Docker target or runtime profile"
    for marker in migrations tests/integration docs/api/openapi.yaml deploy/prometheus Dockerfile cmd/worker; do
      [[ ! -e "${module_dir}/${marker}" ]] ||
        fail "a pure module contains an undeclared capability marker: ${marker}"
    done
    return
  fi

  if has_capability "${capabilities}" "database"; then
    [[ -d "${module_dir}/migrations" ]] || fail "database capability requires migrations"
    [[ -d "${module_dir}/tests/integration" ]] ||
      fail "database capability requires tests/integration"
    local up_migration
    up_migration="$(
      find "${module_dir}/migrations" -maxdepth 1 -type f -name '*.up.sql' -print -quit
    )"
    [[ -n "${up_migration}" ]] || fail "migrations contains no up migration"
    db_ref=1
  elif [[ -e "${module_dir}/migrations" || -e "${module_dir}/tests/integration" ]]; then
    fail "database artifacts require a declared database capability"
  fi

  if has_capability "${capabilities}" "http-openapi"; then
    [[ -f "${module_dir}/docs/api/openapi.yaml" ]] ||
      fail "HTTP capability requires docs/api/openapi.yaml"
    [[ -d "${module_dir}/tests/contracts" ]] ||
      fail "HTTP capability requires tests/contracts"
    local contract_test
    contract_test="$(
      find "${module_dir}/tests/contracts" -type f -name '*_test.go' -print -quit
    )"
    [[ -n "${contract_test}" ]] ||
      fail "HTTP capability requires a Go contract test"
    [[ -f "${module_dir}/Dockerfile" ]] ||
      fail "an HTTP module requires a Dockerfile for its health smoke"
    http_ref=1
  elif [[ -e "${module_dir}/docs/api/openapi.yaml" ]]; then
    fail "OpenAPI artifacts require a declared HTTP capability"
  fi

  if has_capability "${capabilities}" "prometheus"; then
    [[ -d "${module_dir}/deploy/prometheus" ]] ||
      fail "Prometheus capability requires deploy/prometheus"
    local artifact
    for artifact in prometheus.yml alerts.yml rules.test.yml; do
      [[ -f "${module_dir}/deploy/prometheus/${artifact}" ]] ||
        fail "Prometheus capability is missing ${artifact}"
    done
    prometheus_ref=1
  elif [[ -e "${module_dir}/deploy/prometheus" ]]; then
    fail "Prometheus artifacts require a declared Prometheus capability"
  fi

  if has_capability "${capabilities}" "distribution"; then
    [[ -f "${module_dir}/Dockerfile" ]] ||
      fail "distribution capability requires a Dockerfile"
    local artifact
    for artifact in \
      SBOM.cdx.json \
      LICENSE \
      NOTICE \
      THIRD_PARTY_NOTICES.md \
      .dockerignore \
      integration/source-manifest.v2.json; do
      [[ -f "${module_dir}/${artifact}" ]] ||
        fail "distribution capability is missing ${artifact}"
    done
    validate_dockerignore "${module_dir}/.dockerignore"
    [[ "${docker_target_ref}" != "none" ]] ||
      fail "distribution capability requires a reviewed Docker target"
    distribution_ref=1
  elif [[ -e "${module_dir}/Dockerfile" ]]; then
    fail "Dockerfile requires a declared distribution capability"
  fi

  if has_capability "${capabilities}" "worker"; then
    if [[ "${runtime_profile_ref}" == "notification-delivery-v1" ]]; then
      local worker_evidence
      for worker_evidence in \
        internal/delivery/worker_test.go \
        internal/delivery/backoff_test.go \
        internal/leaserecovery/runner_test.go \
        internal/reliability/service_test.go \
        tests/integration/delivery_test.go \
        tests/integration/notificationstore_test.go \
        tests/integration/operations_observability_test.go; do
        [[ -f "${module_dir}/${worker_evidence}" ]] ||
          fail "Notification Delivery worker capability is missing ${worker_evidence}"
      done
    elif [[ "${runtime_profile_ref}" == "workflow-control-runner-v1" ||
      "${runtime_profile_ref}" == "workflow-control-authority-v2" ||
      "${runtime_profile_ref}" == "workflow-control-checkpoint-shadow-v1" ||
      "${runtime_profile_ref}" == "workflow-control-effect-shadow-v1" ||
      "${runtime_profile_ref}" == "workflow-control-budget-authority-v1" ]]; then
      local runner_evidence
      for runner_evidence in \
        cmd/runner-server/main.go \
        cmd/runner-server/qualification_test.go \
        internal/processsupervisor/supervisor_test.go \
        internal/runnerscheduler/session_test.go \
        internal/runnerstore/postgres/runner_runtime_integration_test.go; do
        [[ -f "${module_dir}/${runner_evidence}" ]] ||
          fail "Workflow Control runner capability is missing ${runner_evidence}"
      done
    else
      [[ -f "${module_dir}/cmd/worker/main.go" ]] ||
        fail "worker capability requires cmd/worker/main.go"
      local generic_worker_test
      generic_worker_test="$(
        find "${module_dir}" -type f -path '*/worker/*_test.go' -print -quit
      )"
      [[ -n "${generic_worker_test}" ]] ||
        fail "worker capability requires worker-specific Go tests"
    fi
    worker_ref=1
  elif [[ -e "${module_dir}/cmd/worker" ]]; then
    fail "cmd/worker requires a declared worker capability"
  fi

  if [[ "${runtime_profile_ref}" == "notification-delivery-v1" ]] &&
    ! has_capability "${capabilities}" "worker"; then
    fail "Notification Delivery runtime profile requires the worker capability"
  fi
  if [[ "${runtime_profile_ref}" == "workflow-control-runner-v1" ||
    "${runtime_profile_ref}" == "workflow-control-authority-v2" ||
    "${runtime_profile_ref}" == "workflow-control-checkpoint-shadow-v1" ||
    "${runtime_profile_ref}" == "workflow-control-effect-shadow-v1" ||
    "${runtime_profile_ref}" == "workflow-control-budget-authority-v1" ]] &&
    ! has_capability "${capabilities}" "worker"; then
    fail "Workflow Control runner runtime profile requires the worker capability"
  fi

  if [[ "${runtime_profile_ref}" == "governance-control-v1" ||
    "${runtime_profile_ref}" == "governance-control-v2" ]]; then
    local governance_evidence
    for governance_evidence in \
      cmd/server/qualification_test.go \
      tests/contracts/openapi_contract_test.go; do
      [[ -f "${module_dir}/${governance_evidence}" ]] ||
        fail "Governance Control runtime profile is missing ${governance_evidence}"
    done
    if [[ "${runtime_profile_ref}" == "governance-control-v2" ]]; then
      local gs6_test
      for gs6_test in TestGS6Qualification TestGS6RestartQualification TestGS6ImageSmoke; do
        grep -Eq "^func[[:space:]]+${gs6_test}\\(" "${module_dir}"/cmd/server/*_test.go ||
          fail "Governance Control v2 runtime profile is missing ${gs6_test}"
      done
    fi
  fi

  if [[ "${runtime_profile_ref}" == "workflow-control-shadow-v1" ||
    "${runtime_profile_ref}" == "workflow-control-runner-v1" ||
    "${runtime_profile_ref}" == "workflow-control-authority-v2" ||
    "${runtime_profile_ref}" == "workflow-control-checkpoint-shadow-v1" ||
    "${runtime_profile_ref}" == "workflow-control-effect-shadow-v1" ||
    "${runtime_profile_ref}" == "workflow-control-budget-authority-v1" ]]; then
    local workflow_control_evidence
    for workflow_control_evidence in \
      cmd/server/qualification_test.go \
      internal/app/handlers_test.go \
      internal/shadowstore/postgres/repository_test.go \
      tests/contracts/openapi_contract_test.go; do
      [[ -f "${module_dir}/${workflow_control_evidence}" ]] ||
        fail "Workflow Control shadow runtime profile is missing ${workflow_control_evidence}"
    done
    local workflow_control_test workflow_control_test_file
    for workflow_control_test in \
      TestGS7BQualification \
      TestGS7BRestartQualification \
      TestGS7BImageSmoke; do
      grep -Eq "^func[[:space:]]+${workflow_control_test}\\(" "${module_dir}"/cmd/server/*_test.go ||
        fail "Workflow Control shadow runtime profile is missing ${workflow_control_test}"
    done
    for workflow_control_test_file in \
      'internal/app/handlers_test.go:TestObservationProjectionAndClosedRouteSurface' \
      'internal/app/handlers_test.go:TestObservationRejectsStoreReceiptStateDrift' \
      'internal/shadowstore/postgres/repository_test.go:TestUnknownCommitPersistsStableReconciliationReceipt' \
      'tests/contracts/openapi_contract_test.go:TestOpenAPIIsValidAndContainsOnlyShadowRoutes'; do
      local evidence_path="${workflow_control_test_file%%:*}"
      local evidence_test="${workflow_control_test_file#*:}"
      grep -Eq "^func[[:space:]]+${evidence_test}\\(" "${module_dir}/${evidence_path}" ||
        fail "Workflow Control shadow runtime profile is missing ${evidence_test}"
    done
  fi

  if [[ "${runtime_profile_ref}" == "workflow-control-runner-v1" ||
    "${runtime_profile_ref}" == "workflow-control-authority-v2" ||
    "${runtime_profile_ref}" == "workflow-control-checkpoint-shadow-v1" ||
    "${runtime_profile_ref}" == "workflow-control-effect-shadow-v1" ||
    "${runtime_profile_ref}" == "workflow-control-budget-authority-v1" ]]; then
    local workflow_runner_evidence
    for workflow_runner_evidence in \
      cmd/runner-server/qualification_test.go \
      docs/api/runner-openapi.yaml \
      tests/contracts/runner_openapi_contract_test.go; do
      [[ -f "${module_dir}/${workflow_runner_evidence}" ]] ||
        fail "Workflow Control runner runtime profile is missing ${workflow_runner_evidence}"
    done
    local workflow_runner_test
    for workflow_runner_test in \
      TestGS8BQualification \
      TestGS8BQualificationProcessIdentityIsStableWithinOneProcess \
      TestGS8BRestartQualification \
      TestGS8BImageDefaultOff; do
      grep -Eq "^func[[:space:]]+${workflow_runner_test}\\(" "${module_dir}"/cmd/runner-server/*_test.go ||
        fail "Workflow Control runner runtime profile is missing ${workflow_runner_test}"
    done
  fi

  if [[ "${runtime_profile_ref}" == "workflow-control-authority-v2" ||
    "${runtime_profile_ref}" == "workflow-control-checkpoint-shadow-v1" ||
    "${runtime_profile_ref}" == "workflow-control-effect-shadow-v1" ||
    "${runtime_profile_ref}" == "workflow-control-budget-authority-v1" ]]; then
    local workflow_authority_evidence
    for workflow_authority_evidence in \
      cmd/authority-server/main.go \
      cmd/authority-server/qualification_test.go \
      docs/api/authority-openapi.yaml \
      internal/authorityapp/server_test.go \
      internal/authoritystore/postgres/repository_test.go \
      internal/authoritystore/request_test.go \
      tests/integration/migration_test.go \
      tests/contracts/authority_openapi_contract_test.go; do
      [[ -f "${module_dir}/${workflow_authority_evidence}" ]] ||
        fail "Workflow Control authority runtime profile is missing ${workflow_authority_evidence}"
    done
    local workflow_authority_test
    for workflow_authority_test in \
      TestGS9BQualification \
      TestGS9BRestartQualification \
      TestGS9BImageDefaultOff; do
      grep -Eq "^func[[:space:]]+${workflow_authority_test}\\(" \
        "${module_dir}"/cmd/authority-server/*_test.go ||
        fail "Workflow Control authority runtime profile is missing ${workflow_authority_test}"
    done
    grep -Eq '^func[[:space:]]+TestAuthorityOpenAPIContract\(' \
      "${module_dir}/tests/contracts/authority_openapi_contract_test.go" ||
      fail "Workflow Control authority runtime profile is missing TestAuthorityOpenAPIContract"
    local workflow_authority_store_test
    for workflow_authority_store_test in \
      TestGS9BAuthorityAcceptAndByteIdenticalReplay \
      TestGS9BAuthorityReadRejectsTamperedCanonicalRecordBytes \
      TestGS9BAuthorityReadRejectsTamperedCanonicalOutboxBytes \
      TestGS9BAuthorityRejectsCorruptStoredReceiptAsIntegrityFailure \
      TestGS9BAuthorityReadyUsesLightweightProbe \
      TestGS9BAuthoritySameKeyDifferentFingerprintConflicts \
      TestGS9BAuthorityTransitionCASAndOutboxAtomicity \
      TestGS9BAuthorityRouteDriftConflicts \
      TestGS9BAuthorityConcurrentCASHasOneWinner \
      TestGS9BAuthorityCommittedResponseLossRecoversExactReceipt \
      TestGS9BAuthorityUnknownCommitPersistsReconciliationWithoutHead \
      TestGS9BAuthorityDoubleUnknownFailsClosed; do
      grep -Eq "^func[[:space:]]+${workflow_authority_store_test}\\(" \
        "${module_dir}"/internal/authoritystore/postgres/*_test.go ||
        fail "Workflow Control authority runtime profile is missing ${workflow_authority_store_test}"
    done
    local workflow_authority_named_test
    for workflow_authority_named_test in \
      'internal/authoritystore/request_test.go:TestPrepareRequestRejectsNonCanonicalAndInvalidTransition' \
      'internal/authorityapp/server_test.go:TestServiceDefaultsToHealthOnly' \
      'internal/authorityapp/server_test.go:TestServiceMapsCommitUnknownToStableNon2xx' \
      'internal/authorityapp/server_test.go:TestServiceMapsStoredIntegrityFailureTo500' \
      'internal/authorityapp/server_test.go:TestQualificationReadinessUsesLightweightProbe' \
      'internal/authorityapp/server_test.go:TestQualificationReadinessFailureIsNotReady' \
      'internal/authorityapp/server_test.go:TestAuthorityTimeoutBudgetsLeaveWriteSlack' \
      'tests/integration/migration_test.go:TestMigrationCreatesIsolatedShadowRunnerAndAuthorityNamespacesWithImmutableEvidence' \
      'tests/integration/migration_test.go:TestAuthorityMigrationDoesNotClaimLaterGS9OrRunnerLifecycle' \
      'tests/integration/migration_test.go:TestAuthorityDownMigrationIsIsolatedAndRefusesRegisteredEpochs'; do
      local named_evidence_path="${workflow_authority_named_test%%:*}"
      local named_evidence_test="${workflow_authority_named_test#*:}"
      grep -Eq "^func[[:space:]]+${named_evidence_test}\\(" \
        "${module_dir}/${named_evidence_path}" ||
        fail "Workflow Control authority runtime profile is missing ${named_evidence_test}"
    done
  fi

  if [[ "${runtime_profile_ref}" == "workflow-control-checkpoint-shadow-v1" ||
    "${runtime_profile_ref}" == "workflow-control-effect-shadow-v1" ||
    "${runtime_profile_ref}" == "workflow-control-budget-authority-v1" ]]; then
    local checkpoint_shadow_root_evidence
    for checkpoint_shadow_root_evidence in \
      scripts/workflow-checkpoint-shadow-contracts/index.ts \
      scripts/workflow-checkpoint-shadow-contracts/tsconfig.json \
      packages/workflows/contracts/workflow-checkpoint-shadow/v1/manifest.json \
      packages/workflows/contracts/workflow-checkpoint-shadow/v1/golden-vectors.json; do
      [[ -f "${repo_root}/${checkpoint_shadow_root_evidence}" ]] ||
        fail "Workflow Control checkpoint shadow runtime profile is missing ${checkpoint_shadow_root_evidence}"
    done
    local checkpoint_shadow_evidence
    for checkpoint_shadow_evidence in \
      cmd/checkpoint-shadow-server/main.go \
      cmd/checkpoint-shadow-server/qualification_test.go \
      docs/api/checkpoint-shadow-openapi.yaml \
      internal/checkpointshadowapp/server_test.go \
      internal/checkpointshadowstore/postgres/repository_test.go \
      migrations/000004_create_workflow_control_checkpoint_shadow.up.sql \
      migrations/000004_create_workflow_control_checkpoint_shadow.down.sql \
      tests/contracts/checkpoint_shadow_openapi_contract_test.go; do
      [[ -f "${module_dir}/${checkpoint_shadow_evidence}" ]] ||
        fail "Workflow Control checkpoint shadow runtime profile is missing ${checkpoint_shadow_evidence}"
    done
    local checkpoint_shadow_test
    for checkpoint_shadow_test in \
      TestGS9CQualification \
      TestGS9CRestartQualification \
      TestGS9CImageDefaultOff; do
      grep -Eq "^func[[:space:]]+${checkpoint_shadow_test}\\(" \
        "${module_dir}"/cmd/checkpoint-shadow-server/*_test.go ||
        fail "Workflow Control checkpoint shadow runtime profile is missing ${checkpoint_shadow_test}"
    done
    grep -Eq '^func[[:space:]]+TestCheckpointShadowOpenAPIIsClosedAndValid\(' \
      "${module_dir}/tests/contracts/checkpoint_shadow_openapi_contract_test.go" ||
      fail "Workflow Control checkpoint shadow runtime profile is missing TestCheckpointShadowOpenAPIIsClosedAndValid"
  fi

  if [[ "${runtime_profile_ref}" == "workflow-control-effect-shadow-v1" ||
    "${runtime_profile_ref}" == "workflow-control-budget-authority-v1" ]]; then
    local effect_shadow_root_evidence
    for effect_shadow_root_evidence in \
      scripts/workflow-effect-shadow-contracts/index.ts \
      scripts/workflow-effect-shadow-contracts/tsconfig.json \
      packages/workflows/contracts/workflow-effect-shadow/v1/manifest.json \
      packages/workflows/contracts/workflow-effect-shadow/v1/golden-vectors.json; do
      [[ -f "${repo_root}/${effect_shadow_root_evidence}" ]] ||
        fail "Workflow Control effect shadow runtime profile is missing ${effect_shadow_root_evidence}"
    done
    local effect_shadow_evidence
    for effect_shadow_evidence in \
      cmd/effect-shadow-server/main.go \
      cmd/effect-shadow-server/qualification_test.go \
      docs/api/effect-shadow-openapi.yaml \
      internal/effectshadowapp/server_test.go \
      internal/effectshadowstore/contract_test.go \
      internal/effectshadowstore/postgres/repository_test.go \
      migrations/000005_create_workflow_control_effect_shadow.up.sql \
      migrations/000005_create_workflow_control_effect_shadow.down.sql \
      tests/contracts/effect_shadow_openapi_contract_test.go; do
      [[ -f "${module_dir}/${effect_shadow_evidence}" ]] ||
        fail "Workflow Control effect shadow runtime profile is missing ${effect_shadow_evidence}"
    done
    local effect_shadow_test
    for effect_shadow_test in \
      TestGS9DQualification \
      TestGS9DRestartQualification \
      TestGS9DImageDefaultOff; do
      grep -Eq "^func[[:space:]]+${effect_shadow_test}\\(" \
        "${module_dir}"/cmd/effect-shadow-server/*_test.go ||
        fail "Workflow Control effect shadow runtime profile is missing ${effect_shadow_test}"
    done
    grep -Eq '^func[[:space:]]+TestEffectShadowOpenAPIIsClosedAndValid\(' \
      "${module_dir}/tests/contracts/effect_shadow_openapi_contract_test.go" ||
      fail "Workflow Control effect shadow runtime profile is missing TestEffectShadowOpenAPIIsClosedAndValid"
    local effect_shadow_contract_test
    for effect_shadow_contract_test in \
      TestWorkflowEffectShadowGoldenVectors \
      TestWorkflowEffectShadowRejectsFramingAndAuthorityDrift; do
      grep -Eq "^func[[:space:]]+${effect_shadow_contract_test}\\(" \
        "${module_dir}/internal/effectshadowstore/contract_test.go" ||
        fail "Workflow Control effect shadow runtime profile is missing ${effect_shadow_contract_test}"
    done
    local effect_shadow_store_test
    for effect_shadow_store_test in \
      TestGS9DEffectShadowLifecycleOutboxAndExactReplay \
      TestGS9DEffectShadowOutboxPaginationTraversesBeyondFirstHundred \
      TestGS9DEffectShadowMismatchDoesNotCreateOutbox \
      TestGS9DEffectShadowCommittedResponseLossKeepsOutboxAtomic \
      TestGS9DEffectShadowRejectsCorruptOutboxPayload \
      TestGS9DEffectShadowConflictsConcurrencyAndStoredIntegrity \
      TestGS9DEffectShadowCommitUnknownReconciliationAndDoubleUnknown \
      TestGS9DEffectShadowCommitUnknownRereadsReceiptAfterScopeLock; do
      grep -Eq "^func[[:space:]]+${effect_shadow_store_test}\\(" \
        "${module_dir}"/internal/effectshadowstore/postgres/*_test.go ||
        fail "Workflow Control effect shadow runtime profile is missing ${effect_shadow_store_test}"
    done
    grep -Eq '^func[[:space:]]+TestEffectShadowDownMigrationIsIsolatedAndRefusesEvidence\(' \
      "${module_dir}/tests/integration/migration_test.go" ||
      fail "Workflow Control effect shadow runtime profile is missing TestEffectShadowDownMigrationIsIsolatedAndRefusesEvidence"
  fi

  if [[ "${runtime_profile_ref}" == "workflow-control-budget-authority-v1" ]]; then
    local budget_authority_root_evidence
    for budget_authority_root_evidence in \
      scripts/workflow-budget-authority-contracts/index.ts \
      scripts/workflow-budget-authority-contracts/tsconfig.json \
      packages/workflows/contracts/workflow-budget-authority/v1/manifest.json \
      packages/workflows/contracts/workflow-budget-authority/v1/golden-vectors.json; do
      [[ -f "${repo_root}/${budget_authority_root_evidence}" ]] ||
        fail "Workflow Control budget authority runtime profile is missing ${budget_authority_root_evidence}"
    done
    local budget_authority_evidence
    for budget_authority_evidence in \
      cmd/budget-authority-server/main.go \
      cmd/budget-authority-server/main_test.go \
      cmd/budget-authority-server/qualification_test.go \
      docs/api/budget-authority-openapi.yaml \
      internal/budgetapp/qualification_ordering_test.go \
      internal/budgetapp/server_test.go \
      internal/budgetstore/durable_test.go \
      internal/budgetstore/postgres/cross_authority_test.go \
      internal/budgetstore/postgres/replay_order_test.go \
      internal/budgetstore/postgres/repository_test.go \
      internal/budgetstore/response_test.go \
      internal/config/budget_authority_test.go \
      internal/databaseready/databaseready_test.go \
      testdata/gs9e-qualification.conf \
      migrations/000006_create_workflow_control_budget_authority.up.sql \
      migrations/000006_create_workflow_control_budget_authority.down.sql \
      tests/contracts/budget_authority_openapi_contract_test.go \
      tests/integration/migration_test.go; do
      [[ -f "${module_dir}/${budget_authority_evidence}" ]] ||
        fail "Workflow Control budget authority runtime profile is missing ${budget_authority_evidence}"
    done
    local budget_authority_test
    for budget_authority_test in \
      TestGS9EQualification \
      TestGS9ERestartQualification \
      TestGS9EImageDefaultOff; do
      grep -Eq "^func[[:space:]]+${budget_authority_test}\\(" \
        "${module_dir}"/cmd/budget-authority-server/*_test.go ||
        fail "Workflow Control budget authority runtime profile is missing ${budget_authority_test}"
    done
    grep -Eq '^func[[:space:]]+TestBudgetAuthorityOpenAPIContract\(' \
      "${module_dir}/tests/contracts/budget_authority_openapi_contract_test.go" ||
      fail "Workflow Control budget authority runtime profile is missing TestBudgetAuthorityOpenAPIContract"
    local budget_authority_named_test test_path test_function
    for budget_authority_named_test in \
      'cmd/budget-authority-server/main_test.go|TestBudgetAuthorityServerRequiresSchemaVersionSixOnly' \
      'internal/databaseready/databaseready_test.go|TestSchemaProfilesAcceptMigrationSixWithoutRaisingExistingMinimums' \
      'internal/config/budget_authority_test.go|TestBudgetAuthorityRejectsNonCanonicalQualificationSeed' \
      'internal/config/budget_authority_test.go|TestBudgetAuthorityDisabledDoesNotRetainDatabaseOrIdentityBindings' \
      'internal/budgetapp/server_test.go|TestBudgetServiceDefaultsToHealthOnlyWithoutMetrics' \
      'internal/budgetapp/server_test.go|TestBudgetServiceRejectsIncompleteComposition' \
      'internal/budgetapp/server_test.go|TestBudgetServicePinsBearerAndAllQualificationBindings' \
      'internal/budgetapp/server_test.go|TestBudgetServiceEnforcesCanonicalContentAndExactHeaders' \
      'internal/budgetapp/server_test.go|TestBudgetServiceReturnsClosedExactOriginalResponseOnReplay' \
      'internal/budgetapp/server_test.go|TestBudgetServiceFreshRejectedReserveStillReturnsDurableCreatedResponse' \
      'internal/budgetapp/server_test.go|TestBudgetServiceClassifiesAllClosedFreshMutationStatuses' \
      'internal/budgetapp/server_test.go|TestBudgetServiceReadEndpointsReturnExactDurableRecords' \
      'internal/budgetapp/server_test.go|TestBudgetServiceMapsStableStoreErrors' \
      'internal/budgetapp/server_test.go|TestBudgetQualificationRouteDriftReturnsRepositoryConflict' \
      'internal/budgetapp/server_test.go|TestBudgetQualificationExactReplaySurvivesActiveBuildDrift' \
      'internal/budgetapp/server_test.go|TestBudgetQualificationReadinessIsLightweightAndMetricsAreTyped' \
      'internal/budgetapp/server_test.go|TestBudgetQualificationReadinessFailureReturns503' \
      'internal/budgetapp/server_test.go|TestBudgetAuthorityTimeoutBudgetsLeaveResponseSlack' \
      'internal/budgetapp/qualification_ordering_test.go|TestQualificationOnlyOrderingHarnessGatesProviderAndCachePublishOnDurability' \
      'internal/budgetapp/qualification_ordering_test.go|TestQualificationOnlyOrderingHarnessCacheHitPerformsNoRepositoryMutation' \
      'internal/budgetapp/qualification_ordering_test.go|TestQualificationOnlyOrderingHarnessFailsClosedBeforeCallbacks' \
      'internal/budgetstore/durable_test.go|TestDurableRecordExactAuthorityAndProjectionBinding' \
      'internal/budgetstore/response_test.go|TestMutationResponseExactEnvelopeAndCrossSpliceRejection' \
      'internal/budgetstore/postgres/cross_authority_test.go|TestBudgetDatabaseReconciliationSerializesAndGatesAuthorityMutation' \
      'internal/budgetstore/postgres/cross_authority_test.go|TestAuthorityBudgetGateUsesValidatedStartupSchemaVersion' \
      'internal/budgetstore/postgres/replay_order_test.go|TestBudgetStoreExactReplayPrecedesActiveBuildAndPolicyChecks' \
      'internal/budgetstore/postgres/replay_order_test.go|TestBudgetStoreFreshPolicyDriftConflictsWithoutMutation' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreQualification' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreRejectedReserveExactReplay' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreConcurrentNoOverspend' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreFingerprintAndSemanticConflicts' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreSuccessfulAndFailedUsageSettlement' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreCacheHitHasZeroMutation' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreRejectsNonzeroResumeGeneration' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreRouteEpochAndBuildDriftConflictWithoutMutation' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreResponseLossRecovery' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreDatabaseReconciliationResponseLossReplaysLatchedRun' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreDatabaseReconciliationRejectsRunDriftWithoutLatch' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreProviderAndDatabaseUnknownAreSeparate' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreDoubleUnknownFailsClosed' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreSettledReservationCannotSettleTwice' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreRestartRebuild' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreRebuildCoversClosedLedgerKinds' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreRebuildFailsClosedOnAnchorAndLedgerDrift' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreGenesisAnchorIsImmutable' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreKnownReceiptRequiresSafeAcceptedRevisions' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreReservationCloseTimeBindsTerminalLedger' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreRebuildQueryCountIsIndependentOfLedgerLength' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreMigrationIndexesMatchPointReadAndRebuildAccess' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreReservationTerminalShapeIsClosed' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreInt64RoundingAndOverflow' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreAccountRunRevisionDriftIsAConflict' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreImmutableAccountBindingDriftIsIntegrityFailure' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreIntegrityFailure' \
      'internal/budgetstore/postgres/repository_test.go|TestBudgetStoreLegacyApprovalCannotReserve' \
      'tests/integration/migration_test.go|TestBudgetAuthorityMigrationLocksSemanticIndexInventory' \
      'tests/integration/migration_test.go|TestBudgetAuthorityDownMigrationIsIsolatedAndRefusesEvidence' \
      'internal/authoritystore/postgres/repository_test.go|TestGS9BAuthorityMutationRemainsCompatibleWithoutBudgetNamespace'; do
      test_path="${budget_authority_named_test%%|*}"
      test_function="${budget_authority_named_test#*|}"
      grep -Eq "^func[[:space:]]+${test_function}\\(" "${module_dir}/${test_path}" ||
        fail "Workflow Control budget authority runtime profile is missing ${test_function}"
    done
    for budget_authority_semantic_case in \
      'tokens only' \
      'nano usd only' \
      'calls only' \
      'combined'; do
      grep -Fq "name: \"${budget_authority_semantic_case}\"" \
        "${module_dir}/internal/budgetstore/postgres/repository_test.go" ||
        fail "Workflow Control budget authority runtime profile is missing the ${budget_authority_semantic_case} concurrency bound"
    done
    grep -Fq 't.Run("ledger provider attempt receipt binding"' \
      "${module_dir}/internal/budgetstore/postgres/repository_test.go" ||
      fail "Workflow Control budget authority runtime profile is missing the provider-attempt receipt-binding rebuild case"
  fi

  if ((http_ref)); then
    [[ "${runtime_profile_ref}" != "none" ]] ||
      fail "HTTP capability requires a reviewed runtime profile"
  elif [[ "${runtime_profile_ref}" != "none" ]]; then
    fail "a runtime profile requires the HTTP capability"
  fi
}

stage_repository_snapshot() {
  local stage_root archive_path forbidden module
  stage_root="$(mktemp -d -t openslack-go-check-stage.XXXXXX)"
  cleanup_directories+=("${stage_root}")
  archive_path="${stage_root}/repository.tar"
  mkdir -p "${stage_root}/repository"

  run_interruptible git -C "${repo_root}" archive \
    --format=tar \
    --output="${archive_path}" \
    HEAD
  run_interruptible tar -xf "${archive_path}" -C "${stage_root}/repository"
  rm -f -- "${archive_path}"

  for module in "${workspace_modules[@]}"; do
    module="${module#./}"
    [[ -f "${stage_root}/repository/${module}/go.mod" &&
      -f "${stage_root}/repository/${module}/go.sum" ]] ||
      fail "committed module snapshot is incomplete: ${module}"
  done

  forbidden="$(
    find "${stage_root}/repository" \
      \( -type d \( -name .git -o -name .openslack.local -o -name secrets \
      -o \( -name credentials ! -path "${stage_root}/repository/packages/credentials" \) \) \
      -o -type f \( -name .env -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \
      -o -name '*.p12' -o -name '*.pfx' -o -name credentials.json \) \) \
      -print -quit
  )"
  [[ -z "${forbidden}" ]] ||
    fail "committed repository snapshot contains forbidden credential material"

  staged_repository_dir="${stage_root}/repository"
}

wait_for_healthy_container() {
  local container="$1"
  local label="$2"
  local attempt status lifecycle
  for ((attempt = 0; attempt < 60; attempt++)); do
    status="$(docker_cmd inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "${container}")"
    status="${status%$'\r'}"
    lifecycle="$(docker_cmd inspect --format '{{.State.Status}}' "${container}")"
    lifecycle="${lifecycle%$'\r'}"
    if [[ "${lifecycle}" != "running" ]]; then
      fail "${label} container state is ${lifecycle}; expected running"
    fi
    case "${status}" in
      healthy) return 0 ;;
      unhealthy | no-healthcheck) fail "${label} container health is ${status}" ;;
    esac
    sleep 1
  done
  fail "${label} container did not become healthy"
}

start_database() {
  local resource_prefix="$1"
  local database_name="$2"
  local resource_owner="$3"
  local -n network_ref="$4"
  local -n database_container_ref="$5"

  require_image "${POSTGRES_IMAGE}"

  local network_name="${resource_prefix}-net"
  local network_id_file network_id
  local data_volume="${resource_prefix}-db"
  database_container_ref="${resource_prefix}-postgres"

  network_id_file="$(mktemp -t openslack-go-check-network.XXXXXX)"
  cleanup_files+=("${network_id_file}")
  cleanup_network_owners+=("${resource_owner}")
  docker_cmd_interruptible network create \
    --label "com.openslack.go-check.run=${resource_owner}" \
    "${network_name}" >"${network_id_file}"
  network_id="$(<"${network_id_file}")"
  network_id="${network_id%$'\r'}"
  rm -f -- "${network_id_file}"
  [[ "${network_id}" =~ ^[0-9a-f]{12,64}$ ]] ||
    fail "Docker returned an invalid network identity"
  network_ref="${network_id}"
  cleanup_networks+=("${resource_owner}|${network_ref}")
  require_resource_owned network "${network_ref}" "${resource_owner}"
  cleanup_volumes+=("${resource_owner}|${data_volume}")
  docker_cmd_interruptible volume create \
    --label "com.openslack.go-check.run=${resource_owner}" \
    "${data_volume}" >/dev/null
  require_resource_owned volume "${data_volume}" "${resource_owner}"
  cleanup_containers+=("${resource_owner}|${database_container_ref}")
  docker_cmd_interruptible run -d --pull=never \
    --name "${database_container_ref}" \
    --label "com.openslack.go-check.run=${resource_owner}" \
    --network "${network_ref}" \
    --network-alias postgres \
    --env POSTGRES_USER=openslack \
    --env POSTGRES_PASSWORD=openslack-go-check \
    --env "POSTGRES_DB=${database_name}" \
    --health-cmd "pg_isready -U openslack -d ${database_name}" \
    --health-interval 1s \
    --health-timeout 3s \
    --health-retries 60 \
    --mount "type=volume,source=${data_volume},target=/var/lib/postgresql" \
    "${POSTGRES_IMAGE}" >/dev/null
  require_resource_owned container "${database_container_ref}" "${resource_owner}"
  wait_for_healthy_container "${database_container_ref}" "PostgreSQL"
}

run_module_gate() {
  local module="$1"
  local module_slug="${module#services/}"
  [[ -n "${staged_repository_dir}" ]] ||
    fail "committed repository snapshot was not initialized"
  staged_module_dir="${staged_repository_dir}/${module}"
  local stage_root="${staged_repository_dir%/repository}"
  local stage_nonce="${stage_root##*.}"
  local run_token
  run_token="$(date -u +%Y%m%d%H%M%S)-$$-${stage_nonce}"
  local resource_prefix="openslack-gocheck-${module_slug}-${run_token}"
  local database_name="openslack_${run_token//-/_}"
  local network=""
  local database_container=""
  local has_database has_http has_prometheus has_distribution has_worker
  local docker_target runtime_profile
  local resource_owner="${run_token}"
  detect_capabilities \
    "${staged_module_dir}" \
    "${module_slug}" \
    has_database \
    has_http \
    has_prometheus \
    has_distribution \
    has_worker \
    docker_target \
    runtime_profile

  if ((has_database)); then
    start_database \
      "${resource_prefix}" \
      "${database_name}" \
      "${resource_owner}" \
      network \
      database_container
  fi

  local repository_mount container_gate_mount
  repository_mount="$(docker_path "${staged_repository_dir}")"
  container_gate_mount="$(docker_path "${container_gate}")"
  local test_container="${resource_prefix}-test"
  local -a run_args=(
    run --rm --pull=never
    --name "${test_container}"
    --label "com.openslack.go-check.run=${resource_owner}"
    --env GOTOOLCHAIN=local
    --env GOWORK=off
    --env GOMODCACHE=/go/pkg/mod
    --env GOCACHE=/root/.cache/go-build
    --env "GO_CHECK_EXPECTED_MODULE=github.com/Negentropy-Laby/OpenSlack/${module}"
    --env "GO_CHECK_MODULE_RELATIVE_PATH=${module}"
    --mount "type=bind,source=${repository_mount},target=/source,readonly"
    --mount "type=bind,source=${container_gate_mount},target=/input/container-gate.sh,readonly"
    --mount "type=tmpfs,target=/work"
    --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod"
    --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build"
  )
  cleanup_containers+=("${resource_owner}|${test_container}")

  if ((has_database)); then
    run_args+=(
      --network "${network}"
      --env "DATABASE_URL=postgres://openslack:openslack-go-check@postgres:5432/${database_name}?sslmode=disable"
      --env "MIGRATION_DATABASE_URL=pgx5://openslack:openslack-go-check@postgres:5432/${database_name}?sslmode=disable"
    )
  fi
  if [[ "${runtime_profile}" == "notification-delivery-v1" ]]; then
    run_args+=(
      --env 'NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      --env 'API_KEY_PEPPER_ACTIVE={"id":"v1","value":"ci-active-pepper"}'
      --env 'API_KEY_PEPPER_PREVIOUS={"id":"v0","value":"ci-previous-pepper"}'
      --env ENV_CREDENTIAL_ALLOWLIST=VENDOR_TEST_TOKEN
      --env CREDENTIAL_REF_SCHEME_ALLOWLIST=env
      --env CREDENTIAL_PROFILE_VALIDATOR=bearer-env-v1
    )
  elif [[ "${runtime_profile}" == "organization-graph-v1" ]]; then
    run_args+=(
      --env 'GRAPH_QUERY_CURSOR_SECRET=organization-graph-go-check-cursor-secret-v1'
      --env 'GRAPH_QUERY_CURSOR_SECRET_PREVIOUS=organization-graph-go-check-cursor-secret-v0'
      --env 'GRAPH_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      --env GRAPH_HTTP_BIND=127.0.0.1:8080
      --env GRAPH_NETWORK_MODE=loopback
    )
  elif [[ "${runtime_profile}" == "governance-control-v1" ||
    "${runtime_profile}" == "governance-control-v2" ]]; then
    run_args+=(
      --env 'GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      --env GOVERNANCE_HTTP_BIND=127.0.0.1:8080
      --env GOVERNANCE_NETWORK_MODE=loopback
    )
    if [[ "${runtime_profile}" == "governance-control-v2" ]]; then
      run_args+=(
        --env GOVERNANCE_AUTHORITY_MODE=local-qualification-v1
        --env GOVERNANCE_AUTHORITY_WORKSPACE_ID=workspace.demo
        --env GOVERNANCE_AUTHORITY_CALLER_ID=typescript:qoder-mcp
        --env GOVERNANCE_AUTHORITY_ROUTING_EPOCH=7
        --env GOVERNANCE_AUTHORITY_ACCEPT_NEW_RECORDS=true
        --env GOVERNANCE_AUTHORITY_DRAIN_EPOCHS=6
      )
    fi
  elif [[ "${runtime_profile}" == "workflow-control-shadow-v1" ||
    "${runtime_profile}" == "workflow-control-runner-v1" ||
    "${runtime_profile}" == "workflow-control-authority-v2" ||
    "${runtime_profile}" == "workflow-control-checkpoint-shadow-v1" ||
    "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
    "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
    run_args+=(
      --env 'WORKFLOW_CONTROL_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      --env WORKFLOW_CONTROL_HTTP_BIND=127.0.0.1:8080
      --env WORKFLOW_CONTROL_NETWORK_MODE=loopback
    )
    if [[ "${runtime_profile}" == "workflow-control-authority-v2" ||
      "${runtime_profile}" == "workflow-control-checkpoint-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
      run_args+=(
        --env WORKFLOW_CONTROL_AUTHORITY_MODE=local-qualification-v1
        --env WORKFLOW_CONTROL_AUTHORITY_HTTP_BIND=127.0.0.1:8082
        --env 'WORKFLOW_CONTROL_AUTHORITY_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        --env WORKFLOW_CONTROL_AUTHORITY_BEARER_TOKEN_SHA256=047ec1226bb42811637335e29130c659653eca181acad0015ae3fbe35c6d379d
        --env WORKFLOW_CONTROL_AUTHORITY_WORKSPACE_ID=workspace.demo
        --env WORKFLOW_CONTROL_AUTHORITY_CALLER_ID=typescript:workflow-control-qualification
        --env WORKFLOW_CONTROL_AUTHORITY_ROUTING_EPOCH=9
      )
    fi
    if [[ "${runtime_profile}" == "workflow-control-checkpoint-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
      run_args+=(
        --env WORKFLOW_CONTROL_CHECKPOINT_SHADOW_MODE=local-qualification-v1
        --env WORKFLOW_CONTROL_CHECKPOINT_SHADOW_HTTP_BIND=127.0.0.1:8083
        --env 'WORKFLOW_CONTROL_CHECKPOINT_SHADOW_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        --env WORKFLOW_CONTROL_CHECKPOINT_SHADOW_BEARER_TOKEN_SHA256=047ec1226bb42811637335e29130c659653eca181acad0015ae3fbe35c6d379d
        --env WORKFLOW_CONTROL_CHECKPOINT_SHADOW_WORKSPACE_ID=workspace.demo
        --env WORKFLOW_CONTROL_CHECKPOINT_SHADOW_CALLER_ID=typescript:workflow-checkpoint-shadow
      )
    fi
    if [[ "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
      run_args+=(
        --env WORKFLOW_CONTROL_EFFECT_SHADOW_MODE=local-qualification-v1
        --env WORKFLOW_CONTROL_EFFECT_SHADOW_HTTP_BIND=127.0.0.1:8084
        --env 'WORKFLOW_CONTROL_EFFECT_SHADOW_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        --env WORKFLOW_CONTROL_EFFECT_SHADOW_BEARER_TOKEN_SHA256=047ec1226bb42811637335e29130c659653eca181acad0015ae3fbe35c6d379d
        --env WORKFLOW_CONTROL_EFFECT_SHADOW_WORKSPACE_ID=workspace.demo
        --env WORKFLOW_CONTROL_EFFECT_SHADOW_CALLER_ID=typescript:workflow-effect-shadow
      )
    fi
    if [[ "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
      load_workflow_budget_qualification_fixture
      run_args+=(
        --env WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE=local-qualification-v1
        --env WORKFLOW_CONTROL_BUDGET_AUTHORITY_HTTP_BIND=127.0.0.1:8085
        --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_SERVICE_BUILD_SHA=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_SERVICE_BUILD_SHA}"
        --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_BEARER_TOKEN_SHA256=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_BEARER_TOKEN_SHA256}"
        --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_WORKSPACE_ID=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_WORKSPACE_ID}"
        --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_CALLER_ID=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_CALLER_ID}"
        --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH}"
        --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH}"
        --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS}"
        --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD}"
        --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS}"
      )
    fi
  fi

  log "validating ${module} with the pinned Go image"
  docker_cmd_interruptible "${run_args[@]}" "${GO_IMAGE}" \
    sh /input/container-gate.sh /source /work

  if [[ "${runtime_profile}" == "organization-graph-v1" ]]; then
    ((has_database)) || fail "Organization Graph qualification requires PostgreSQL"
    run_organization_graph_qualification \
      "${resource_prefix}" \
      "${network}" \
      "${database_container}" \
      "${database_name}" \
      "${resource_owner}" \
      "${run_token}"
  elif [[ "${runtime_profile}" == "governance-control-v1" ||
    "${runtime_profile}" == "governance-control-v2" ]]; then
    ((has_database)) || fail "Governance Control qualification requires PostgreSQL"
    run_governance_control_qualification \
      "${resource_prefix}" \
      "${network}" \
      "${database_container}" \
      "${database_name}" \
      "${resource_owner}" \
      "${run_token}"
    if [[ "${runtime_profile}" == "governance-control-v2" ]]; then
      run_governance_control_authority_qualification \
        "${resource_prefix}" \
        "${network}" \
        "${database_container}" \
        "${database_name}" \
        "${resource_owner}" \
        "${run_token}"
    fi
  elif [[ "${runtime_profile}" == "workflow-control-shadow-v1" ||
    "${runtime_profile}" == "workflow-control-runner-v1" ||
    "${runtime_profile}" == "workflow-control-authority-v2" ||
    "${runtime_profile}" == "workflow-control-checkpoint-shadow-v1" ||
    "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
    "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
    ((has_database)) || fail "Workflow Control shadow qualification requires PostgreSQL"
    run_workflow_control_qualification \
      "${resource_prefix}" \
      "${network}" \
      "${database_container}" \
      "${database_name}" \
      "${resource_owner}" \
      "${run_token}"
    if [[ "${runtime_profile}" == "workflow-control-runner-v1" ||
      "${runtime_profile}" == "workflow-control-authority-v2" ||
      "${runtime_profile}" == "workflow-control-checkpoint-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
      run_workflow_runner_qualification \
        "${resource_prefix}" \
        "${network}" \
        "${database_container}" \
        "${database_name}" \
        "${resource_owner}" \
        "${run_token}"
    fi
    if [[ "${runtime_profile}" == "workflow-control-authority-v2" ||
      "${runtime_profile}" == "workflow-control-checkpoint-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
      run_workflow_authority_qualification \
        "${resource_prefix}" \
        "${network}" \
        "${database_container}" \
        "${database_name}" \
        "${resource_owner}" \
        "${run_token}"
    fi
    if [[ "${runtime_profile}" == "workflow-control-checkpoint-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
      run_workflow_checkpoint_shadow_qualification \
        "${resource_prefix}" \
        "${network}" \
        "${database_container}" \
        "${database_name}" \
        "${resource_owner}" \
        "${run_token}"
    fi
    if [[ "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
      run_workflow_effect_shadow_qualification \
        "${resource_prefix}" \
        "${network}" \
        "${database_container}" \
        "${database_name}" \
        "${resource_owner}" \
        "${run_token}"
    fi
    if [[ "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
      run_workflow_budget_authority_qualification \
        "${resource_prefix}" \
        "${network}" \
        "${database_container}" \
        "${database_name}" \
        "${resource_owner}" \
        "${run_token}"
    fi
  fi

  if ((has_prometheus)); then
    run_prometheus_gate "${staged_module_dir}"
  fi

  local image_tag=""
  if ((has_distribution)); then
    image_tag="openslack-gocheck-${module_slug}:${run_token}"
    run_distribution_gate \
      "${staged_module_dir}" \
      "${image_tag}" \
      "${docker_target}" \
      "${resource_owner}"
  fi

  if ((has_http)); then
    [[ -n "${image_tag}" ]] || fail "HTTP health smoke requires a built image"
    run_http_smoke \
      "${resource_prefix}" \
      "${image_tag}" \
      "${network}" \
      "${database_name}" \
      "${has_database}" \
      "${runtime_profile}" \
      "${resource_owner}"
  fi

  log "${module} passed"
}

run_organization_graph_test_container() {
  local resource_prefix="$1"
  local label="$2"
  local network="$3"
  local database_name="$4"
  local resource_owner="$5"
  shift 5
  local container="${resource_prefix}-qualification-${label}"
  local repository_mount
  repository_mount="$(docker_path "${staged_repository_dir}")"
  local -a run_args=(
    run --rm --pull=never
    --name "${container}"
    --label "com.openslack.go-check.run=${resource_owner}"
    --network "${network}"
    --env GOTOOLCHAIN=local
    --env GOWORK=off
    --env GOMODCACHE=/go/pkg/mod
    --env GOCACHE=/root/.cache/go-build
    --env "DATABASE_URL=postgres://openslack:openslack-go-check@postgres:5432/${database_name}?sslmode=disable"
    --mount "type=bind,source=${repository_mount},target=/source,readonly"
    --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod"
    --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build"
    --workdir /source/services/organization-graph
  )
  cleanup_containers+=("${resource_owner}|${container}")
  while (($#)); do
    run_args+=(--env "$1")
    shift
  done
  docker_cmd_interruptible "${run_args[@]}" "${GO_IMAGE}" \
    go test -race ./cmd/server -run '^TestGS1C' -count=1
}

run_organization_graph_qualification() {
  local resource_prefix="$1"
  local network="$2"
  local database_container="$3"
  local database_name="$4"
  local resource_owner="$5"
  local run_token="$6"
  local restart_token="${run_token,,}"
  local restart_schema="organization_graph_gs1c_restart_${restart_token//-/}"

  log "qualifying Organization Graph schema, size, HTTP/PostgreSQL, and failure bounds"
  run_organization_graph_test_container \
    "${resource_prefix}" bounds "${network}" "${database_name}" "${resource_owner}" \
    GRAPH_GS1C_SCHEMA_QUALIFICATION=1 \
    GRAPH_GS1C_LARGE_QUALIFICATION=1

  log "seeding Organization Graph restart qualification"
  run_organization_graph_test_container \
    "${resource_prefix}" restart-seed "${network}" "${database_name}" "${resource_owner}" \
    GRAPH_GS1C_RESTART_PHASE=seed \
    "GRAPH_GS1C_RESTART_SCHEMA=${restart_schema}"

  require_resource_owned container "${database_container}" "${resource_owner}"
  docker_cmd_interruptible restart "${database_container}" >/dev/null
  wait_for_healthy_container "${database_container}" "PostgreSQL after restart"

  log "verifying Organization Graph durable state after PostgreSQL restart"
  run_organization_graph_test_container \
    "${resource_prefix}" restart-verify "${network}" "${database_name}" "${resource_owner}" \
    GRAPH_GS1C_RESTART_PHASE=verify \
    "GRAPH_GS1C_RESTART_SCHEMA=${restart_schema}"
}

run_governance_control_test_container() {
  local resource_prefix="$1"
  local label="$2"
  local network="$3"
  local database_name="$4"
  local resource_owner="$5"
  shift 5
  local container="${resource_prefix}-qualification-${label}"
  local repository_mount
  repository_mount="$(docker_path "${staged_repository_dir}")"
  local -a run_args=(
    run --rm --pull=never
    --name "${container}"
    --label "com.openslack.go-check.run=${resource_owner}"
    --network "${network}"
    --env GOTOOLCHAIN=local
    --env GOWORK=off
    --env GOMODCACHE=/go/pkg/mod
    --env GOCACHE=/root/.cache/go-build
    --env "DATABASE_URL=postgres://openslack:openslack-go-check@postgres:5432/${database_name}?sslmode=disable"
    --env 'GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    --mount "type=bind,source=${repository_mount},target=/source,readonly"
    --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod"
    --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build"
    --workdir /source/services/governance-control
  )
  cleanup_containers+=("${resource_owner}|${container}")
  while (($#)); do
    run_args+=(--env "$1")
    shift
  done
  docker_cmd_interruptible "${run_args[@]}" "${GO_IMAGE}" \
    go test -race ./cmd/server -run '^TestGS5' -count=1
}

run_governance_control_qualification() {
  local resource_prefix="$1"
  local network="$2"
  local database_container="$3"
  local database_name="$4"
  local resource_owner="$5"
  local run_token="$6"
  local restart_token="${run_token,,}"
  local restart_schema="governance_control_gs5_restart_${restart_token//-/}"

  log "qualifying Governance Control HTTP/PostgreSQL shadow and failure bounds"
  run_governance_control_test_container \
    "${resource_prefix}" bounds "${network}" "${database_name}" "${resource_owner}" \
    GOVERNANCE_GS5_QUALIFICATION=1

  log "seeding Governance Control restart qualification"
  run_governance_control_test_container \
    "${resource_prefix}" restart-seed "${network}" "${database_name}" "${resource_owner}" \
    GOVERNANCE_GS5_RESTART_PHASE=seed \
    "GOVERNANCE_GS5_RESTART_SCHEMA=${restart_schema}"

  require_resource_owned container "${database_container}" "${resource_owner}"
  docker_cmd_interruptible restart "${database_container}" >/dev/null
  wait_for_healthy_container "${database_container}" "PostgreSQL after restart"

  log "verifying Governance Control durable shadow after PostgreSQL restart"
  run_governance_control_test_container \
    "${resource_prefix}" restart-verify "${network}" "${database_name}" "${resource_owner}" \
    GOVERNANCE_GS5_RESTART_PHASE=verify \
    "GOVERNANCE_GS5_RESTART_SCHEMA=${restart_schema}"
}

run_governance_control_authority_test_container() {
  local resource_prefix="$1"
  local label="$2"
  local network="$3"
  local database_name="$4"
  local resource_owner="$5"
  local test_name="$6"
  shift 6
  local container="${resource_prefix}-qualification-${label}"
  local repository_mount
  repository_mount="$(docker_path "${staged_repository_dir}")"
  local -a run_args=(
    run --rm --pull=never
    --name "${container}"
    --label "com.openslack.go-check.run=${resource_owner}"
    --network "${network}"
    --env GOTOOLCHAIN=local
    --env GOWORK=off
    --env GOMODCACHE=/go/pkg/mod
    --env GOCACHE=/root/.cache/go-build
    --env "DATABASE_URL=postgres://openslack:openslack-go-check@postgres:5432/${database_name}?sslmode=disable"
    --env 'GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    --env GOVERNANCE_AUTHORITY_MODE=local-qualification-v1
    --env GOVERNANCE_AUTHORITY_WORKSPACE_ID=workspace.demo
    --env GOVERNANCE_AUTHORITY_CALLER_ID=typescript:qoder-mcp
    --env GOVERNANCE_AUTHORITY_ROUTING_EPOCH=7
    --env GOVERNANCE_AUTHORITY_ACCEPT_NEW_RECORDS=true
    --env GOVERNANCE_AUTHORITY_DRAIN_EPOCHS=6
    --mount "type=bind,source=${repository_mount},target=/source,readonly"
    --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod"
    --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build"
    --workdir /source/services/governance-control
  )
  cleanup_containers+=("${resource_owner}|${container}")
  while (($#)); do
    run_args+=(--env "$1")
    shift
  done
  docker_cmd_interruptible "${run_args[@]}" "${GO_IMAGE}" \
    go test -race ./cmd/server -run "^${test_name}$" -count=1
}

run_governance_control_authority_qualification() {
  local resource_prefix="$1"
  local network="$2"
  local database_container="$3"
  local database_name="$4"
  local resource_owner="$5"
  local run_token="$6"
  local restart_token="${run_token,,}"
  local restart_schema="governance_control_gs6_restart_${restart_token//-/}"

  log "qualifying Governance Control GS6 durable authority cutover and failure bounds"
  run_governance_control_authority_test_container \
    "${resource_prefix}" authority-bounds "${network}" "${database_name}" "${resource_owner}" \
    TestGS6Qualification \
    GOVERNANCE_GS6_QUALIFICATION=1

  log "seeding Governance Control GS6 authority restart qualification"
  run_governance_control_authority_test_container \
    "${resource_prefix}" authority-restart-seed "${network}" "${database_name}" "${resource_owner}" \
    TestGS6RestartQualification \
    GOVERNANCE_GS6_RESTART_PHASE=seed \
    "GOVERNANCE_GS6_RESTART_SCHEMA=${restart_schema}"

  require_resource_owned container "${database_container}" "${resource_owner}"
  docker_cmd_interruptible restart "${database_container}" >/dev/null
  wait_for_healthy_container "${database_container}" "PostgreSQL after GS6 authority restart"

  log "verifying Governance Control GS6 durable authority after PostgreSQL restart"
  run_governance_control_authority_test_container \
    "${resource_prefix}" authority-restart-verify "${network}" "${database_name}" "${resource_owner}" \
    TestGS6RestartQualification \
    GOVERNANCE_GS6_RESTART_PHASE=verify \
    "GOVERNANCE_GS6_RESTART_SCHEMA=${restart_schema}"
}

run_workflow_control_test_container() {
  local resource_prefix="$1"
  local label="$2"
  local network="$3"
  local database_name="$4"
  local resource_owner="$5"
  local test_name="$6"
  shift 6
  local container="${resource_prefix}-qualification-${label}"
  local repository_mount
  repository_mount="$(docker_path "${staged_repository_dir}")"
  local -a run_args=(
    run --rm --pull=never
    --name "${container}"
    --label "com.openslack.go-check.run=${resource_owner}"
    --network "${network}"
    --env GOTOOLCHAIN=local
    --env GOWORK=off
    --env GOMODCACHE=/go/pkg/mod
    --env GOCACHE=/root/.cache/go-build
    --env "DATABASE_URL=postgres://openslack:openslack-go-check@postgres:5432/${database_name}?sslmode=disable"
    --env 'WORKFLOW_CONTROL_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    --mount "type=bind,source=${repository_mount},target=/source,readonly"
    --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod"
    --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build"
    --workdir /source/services/workflow-control
  )
  cleanup_containers+=("${resource_owner}|${container}")
  while (($#)); do
    run_args+=(--env "$1")
    shift
  done
  docker_cmd_interruptible "${run_args[@]}" "${GO_IMAGE}" \
    go test -race ./cmd/server -run "^${test_name}$" -count=1
}

run_workflow_control_qualification() {
  local resource_prefix="$1"
  local network="$2"
  local database_container="$3"
  local database_name="$4"
  local resource_owner="$5"
  local run_token="$6"
  local restart_token="${run_token,,}"
  local restart_schema="workflow_control_gs7b_restart_${restart_token//-/}"

  log "qualifying Workflow Control GS7-B HTTP/PostgreSQL shadow and failure bounds"
  run_workflow_control_test_container \
    "${resource_prefix}" bounds "${network}" "${database_name}" "${resource_owner}" \
    TestGS7BQualification \
    WORKFLOW_CONTROL_GS7B_QUALIFICATION=1

  log "seeding Workflow Control GS7-B restart qualification"
  run_workflow_control_test_container \
    "${resource_prefix}" restart-seed "${network}" "${database_name}" "${resource_owner}" \
    TestGS7BRestartQualification \
    WORKFLOW_CONTROL_GS7B_RESTART_PHASE=seed \
    "WORKFLOW_CONTROL_GS7B_RESTART_SCHEMA=${restart_schema}"

  require_resource_owned container "${database_container}" "${resource_owner}"
  docker_cmd_interruptible restart "${database_container}" >/dev/null
  wait_for_healthy_container "${database_container}" "PostgreSQL after GS7-B restart"

  log "verifying Workflow Control GS7-B durable shadow after PostgreSQL restart"
  run_workflow_control_test_container \
    "${resource_prefix}" restart-verify "${network}" "${database_name}" "${resource_owner}" \
    TestGS7BRestartQualification \
    WORKFLOW_CONTROL_GS7B_RESTART_PHASE=verify \
    "WORKFLOW_CONTROL_GS7B_RESTART_SCHEMA=${restart_schema}"
}

run_workflow_runner_test_container() {
  local resource_prefix="$1"
  local label="$2"
  local network="$3"
  local database_name="$4"
  local resource_owner="$5"
  local package="$6"
  local test_name="$7"
  local count="$8"
  shift 8
  case "${count}" in
    '' | *[!0-9]* | 0) fail "Workflow Control runner test count must be a positive integer" ;;
  esac
  local container="${resource_prefix}-qualification-${label}"
  local repository_mount
  repository_mount="$(docker_path "${staged_repository_dir}")"
  local -a run_args=(
    run --rm --pull=never
    --name "${container}"
    --label "com.openslack.go-check.run=${resource_owner}"
    --network "${network}"
    --env GOTOOLCHAIN=local
    --env GOWORK=off
    --env GOMODCACHE=/go/pkg/mod
    --env GOCACHE=/root/.cache/go-build
    --env "DATABASE_URL=postgres://openslack:openslack-go-check@postgres:5432/${database_name}?sslmode=disable"
    --mount "type=bind,source=${repository_mount},target=/source,readonly"
    --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod"
    --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build"
    --workdir /source/services/workflow-control
  )
  cleanup_containers+=("${resource_owner}|${container}")
  while (($#)); do
    run_args+=(--env "$1")
    shift
  done
  local -a command=(go test -race "${package}" "-count=${count}")
  if [[ -n "${test_name}" ]]; then
    command+=(-run "^${test_name}$")
  fi
  docker_cmd_interruptible "${run_args[@]}" "${GO_IMAGE}" "${command[@]}"
}

run_workflow_runner_qualification() {
  local resource_prefix="$1"
  local network="$2"
  local database_container="$3"
  local database_name="$4"
  local resource_owner="$5"
  local run_token="$6"
  local restart_token="${run_token,,}"
  local restart_schema="workflow_control_gs8b_restart_${restart_token//-/}"

  log "qualifying Workflow Control GS8-B PostgreSQL runner lifecycle bounds"
  run_workflow_runner_test_container \
    "${resource_prefix}" runner-bounds "${network}" "${database_name}" "${resource_owner}" \
    ./internal/runnerstore/postgres "" 1

  log "qualifying Workflow Control GS8-B cancel acknowledgement stability"
  run_workflow_runner_test_container \
    "${resource_prefix}" runner-cancel-ack-stability "${network}" "${database_name}" "${resource_owner}" \
    ./internal/runnerstore/postgres \
    'Test(CancelAckMustBindPersistedCancel|LateAlreadyTerminalCancelAckPreservesReceiptProvenTerminal)' 100

  log "seeding Workflow Control GS8-B Go/PostgreSQL restart qualification"
  run_workflow_runner_test_container \
    "${resource_prefix}" runner-restart-seed "${network}" "${database_name}" "${resource_owner}" \
    ./cmd/runner-server TestGS8BRestartQualification 1 \
    WORKFLOW_RUNNER_GS8B_RESTART_PHASE=seed \
    "WORKFLOW_RUNNER_GS8B_RESTART_SCHEMA=${restart_schema}"

  require_resource_owned container "${database_container}" "${resource_owner}"
  docker_cmd_interruptible restart "${database_container}" >/dev/null
  wait_for_healthy_container "${database_container}" "PostgreSQL after GS8-B runner restart"

  log "verifying Workflow Control GS8-B durable runner state after PostgreSQL restart"
  run_workflow_runner_test_container \
    "${resource_prefix}" runner-restart-verify "${network}" "${database_name}" "${resource_owner}" \
    ./cmd/runner-server TestGS8BRestartQualification 1 \
    WORKFLOW_RUNNER_GS8B_RESTART_PHASE=verify \
    "WORKFLOW_RUNNER_GS8B_RESTART_SCHEMA=${restart_schema}"
}

run_workflow_authority_test_container() {
  local resource_prefix="$1"
  local label="$2"
  local network="$3"
  local database_name="$4"
  local resource_owner="$5"
  local test_name="$6"
  shift 6
  local container="${resource_prefix}-qualification-${label}"
  local repository_mount
  repository_mount="$(docker_path "${staged_repository_dir}")"
  local -a run_args=(
    run --rm --pull=never
    --name "${container}"
    --label "com.openslack.go-check.run=${resource_owner}"
    --network "${network}"
    --env GOTOOLCHAIN=local
    --env GOWORK=off
    --env GOMODCACHE=/go/pkg/mod
    --env GOCACHE=/root/.cache/go-build
    --env "DATABASE_URL=postgres://openslack:openslack-go-check@postgres:5432/${database_name}?sslmode=disable"
    --env WORKFLOW_CONTROL_AUTHORITY_MODE=local-qualification-v1
    --env WORKFLOW_CONTROL_AUTHORITY_HTTP_BIND=127.0.0.1:8082
    --env 'WORKFLOW_CONTROL_AUTHORITY_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    --env WORKFLOW_CONTROL_AUTHORITY_BEARER_TOKEN_SHA256=047ec1226bb42811637335e29130c659653eca181acad0015ae3fbe35c6d379d
    --env WORKFLOW_CONTROL_AUTHORITY_WORKSPACE_ID=workspace.demo
    --env WORKFLOW_CONTROL_AUTHORITY_CALLER_ID=typescript:workflow-control-qualification
    --env WORKFLOW_CONTROL_AUTHORITY_ROUTING_EPOCH=9
    --mount "type=bind,source=${repository_mount},target=/source,readonly"
    --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod"
    --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build"
    --workdir /source/services/workflow-control
  )
  cleanup_containers+=("${resource_owner}|${container}")
  while (($#)); do
    run_args+=(--env "$1")
    shift
  done
  docker_cmd_interruptible "${run_args[@]}" "${GO_IMAGE}" \
    go test -race ./cmd/authority-server -run "^${test_name}$" -count=1
}

run_workflow_authority_qualification() {
  local resource_prefix="$1"
  local network="$2"
  local database_container="$3"
  local database_name="$4"
  local resource_owner="$5"
  local run_token="$6"
  local restart_token="${run_token,,}"
  local restart_schema="workflow_control_gs9b_restart_${restart_token//-/}"

  log "qualifying Workflow Control GS9-B PostgreSQL authority and failure bounds"
  run_workflow_authority_test_container \
    "${resource_prefix}" authority-bounds "${network}" "${database_name}" "${resource_owner}" \
    TestGS9BQualification \
    WORKFLOW_CONTROL_GS9B_QUALIFICATION=1

  log "seeding Workflow Control GS9-B authority restart qualification"
  run_workflow_authority_test_container \
    "${resource_prefix}" authority-restart-seed "${network}" "${database_name}" "${resource_owner}" \
    TestGS9BRestartQualification \
    WORKFLOW_CONTROL_GS9B_RESTART_PHASE=seed \
    "WORKFLOW_CONTROL_GS9B_RESTART_SCHEMA=${restart_schema}"

  require_resource_owned container "${database_container}" "${resource_owner}"
  docker_cmd_interruptible restart "${database_container}" >/dev/null
  wait_for_healthy_container "${database_container}" "PostgreSQL after GS9-B authority restart"

  log "verifying Workflow Control GS9-B durable authority after PostgreSQL restart"
  run_workflow_authority_test_container \
    "${resource_prefix}" authority-restart-verify "${network}" "${database_name}" "${resource_owner}" \
    TestGS9BRestartQualification \
    WORKFLOW_CONTROL_GS9B_RESTART_PHASE=verify \
    "WORKFLOW_CONTROL_GS9B_RESTART_SCHEMA=${restart_schema}"
}

run_workflow_checkpoint_shadow_test_container() {
  local resource_prefix="$1"
  local label="$2"
  local network="$3"
  local database_name="$4"
  local resource_owner="$5"
  local test_name="$6"
  shift 6
  local container="${resource_prefix}-qualification-${label}"
  local repository_mount
  repository_mount="$(docker_path "${staged_repository_dir}")"
  local -a run_args=(
    run --rm --pull=never
    --name "${container}"
    --label "com.openslack.go-check.run=${resource_owner}"
    --network "${network}"
    --env GOTOOLCHAIN=local
    --env GOWORK=off
    --env GOMODCACHE=/go/pkg/mod
    --env GOCACHE=/root/.cache/go-build
    --env "DATABASE_URL=postgres://openslack:openslack-go-check@postgres:5432/${database_name}?sslmode=disable"
    --env WORKFLOW_CONTROL_CHECKPOINT_SHADOW_MODE=local-qualification-v1
    --env WORKFLOW_CONTROL_CHECKPOINT_SHADOW_HTTP_BIND=127.0.0.1:8083
    --env 'WORKFLOW_CONTROL_CHECKPOINT_SHADOW_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    --env WORKFLOW_CONTROL_CHECKPOINT_SHADOW_BEARER_TOKEN_SHA256=047ec1226bb42811637335e29130c659653eca181acad0015ae3fbe35c6d379d
    --env WORKFLOW_CONTROL_CHECKPOINT_SHADOW_WORKSPACE_ID=workspace.demo
    --env WORKFLOW_CONTROL_CHECKPOINT_SHADOW_CALLER_ID=typescript:workflow-checkpoint-shadow
    --mount "type=bind,source=${repository_mount},target=/source,readonly"
    --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod"
    --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build"
    --workdir /source/services/workflow-control
  )
  cleanup_containers+=("${resource_owner}|${container}")
  while (($#)); do
    run_args+=(--env "$1")
    shift
  done
  docker_cmd_interruptible "${run_args[@]}" "${GO_IMAGE}" \
    go test -race ./cmd/checkpoint-shadow-server -run "^${test_name}$" -count=1
}

run_workflow_checkpoint_shadow_qualification() {
  local resource_prefix="$1"
  local network="$2"
  local database_container="$3"
  local database_name="$4"
  local resource_owner="$5"
  local run_token="$6"
  local restart_token="${run_token,,}"
  local restart_schema="workflow_control_gs9c_restart_${restart_token//-/}"

  log "qualifying Workflow Control GS9-C checkpoint/resume shadow bounds"
  run_workflow_checkpoint_shadow_test_container \
    "${resource_prefix}" checkpoint-bounds "${network}" "${database_name}" "${resource_owner}" \
    TestGS9CQualification \
    WORKFLOW_CONTROL_GS9C_QUALIFICATION=1

  log "seeding Workflow Control GS9-C checkpoint shadow restart qualification"
  run_workflow_checkpoint_shadow_test_container \
    "${resource_prefix}" checkpoint-restart-seed "${network}" "${database_name}" "${resource_owner}" \
    TestGS9CRestartQualification \
    WORKFLOW_CONTROL_GS9C_RESTART_PHASE=seed \
    "WORKFLOW_CONTROL_GS9C_RESTART_SCHEMA=${restart_schema}"

  require_resource_owned container "${database_container}" "${resource_owner}"
  docker_cmd_interruptible restart "${database_container}" >/dev/null
  wait_for_healthy_container "${database_container}" "PostgreSQL after GS9-C checkpoint shadow restart"

  log "verifying Workflow Control GS9-C checkpoint shadow after PostgreSQL restart"
  run_workflow_checkpoint_shadow_test_container \
    "${resource_prefix}" checkpoint-restart-verify "${network}" "${database_name}" "${resource_owner}" \
    TestGS9CRestartQualification \
    WORKFLOW_CONTROL_GS9C_RESTART_PHASE=verify \
    "WORKFLOW_CONTROL_GS9C_RESTART_SCHEMA=${restart_schema}"
}

run_workflow_effect_shadow_test_container() {
  local resource_prefix="$1"
  local label="$2"
  local network="$3"
  local database_name="$4"
  local resource_owner="$5"
  local test_name="$6"
  shift 6
  local container="${resource_prefix}-qualification-${label}"
  local repository_mount
  repository_mount="$(docker_path "${staged_repository_dir}")"
  local -a run_args=(
    run --rm --pull=never
    --name "${container}"
    --label "com.openslack.go-check.run=${resource_owner}"
    --network "${network}"
    --env GOTOOLCHAIN=local
    --env GOWORK=off
    --env GOMODCACHE=/go/pkg/mod
    --env GOCACHE=/root/.cache/go-build
    --env "DATABASE_URL=postgres://openslack:openslack-go-check@postgres:5432/${database_name}?sslmode=disable"
    --env WORKFLOW_CONTROL_EFFECT_SHADOW_MODE=local-qualification-v1
    --env WORKFLOW_CONTROL_EFFECT_SHADOW_HTTP_BIND=127.0.0.1:8084
    --env 'WORKFLOW_CONTROL_EFFECT_SHADOW_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    --env WORKFLOW_CONTROL_EFFECT_SHADOW_BEARER_TOKEN_SHA256=047ec1226bb42811637335e29130c659653eca181acad0015ae3fbe35c6d379d
    --env WORKFLOW_CONTROL_EFFECT_SHADOW_WORKSPACE_ID=workspace.demo
    --env WORKFLOW_CONTROL_EFFECT_SHADOW_CALLER_ID=typescript:workflow-effect-shadow
    --mount "type=bind,source=${repository_mount},target=/source,readonly"
    --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod"
    --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build"
    --workdir /source/services/workflow-control
  )
  cleanup_containers+=("${resource_owner}|${container}")
  while (($#)); do
    run_args+=(--env "$1")
    shift
  done
  docker_cmd_interruptible "${run_args[@]}" "${GO_IMAGE}" \
    go test -race ./cmd/effect-shadow-server -run "^${test_name}$" -count=1
}

run_workflow_effect_shadow_qualification() {
  local resource_prefix="$1"
  local network="$2"
  local database_container="$3"
  local database_name="$4"
  local resource_owner="$5"
  local run_token="$6"
  local restart_token="${run_token,,}"
  local restart_schema="workflow_control_gs9d_restart_${restart_token//-/}"

  log "qualifying Workflow Control GS9-D effect decision/audit shadow bounds"
  run_workflow_effect_shadow_test_container \
    "${resource_prefix}" effect-bounds "${network}" "${database_name}" "${resource_owner}" \
    TestGS9DQualification \
    WORKFLOW_CONTROL_GS9D_QUALIFICATION=1

  log "seeding Workflow Control GS9-D effect shadow restart qualification"
  run_workflow_effect_shadow_test_container \
    "${resource_prefix}" effect-restart-seed "${network}" "${database_name}" "${resource_owner}" \
    TestGS9DRestartQualification \
    WORKFLOW_CONTROL_GS9D_RESTART_PHASE=seed \
    "WORKFLOW_CONTROL_GS9D_RESTART_SCHEMA=${restart_schema}"

  require_resource_owned container "${database_container}" "${resource_owner}"
  docker_cmd_interruptible restart "${database_container}" >/dev/null
  wait_for_healthy_container "${database_container}" "PostgreSQL after GS9-D effect shadow restart"

  log "verifying Workflow Control GS9-D effect shadow after PostgreSQL restart"
  run_workflow_effect_shadow_test_container \
    "${resource_prefix}" effect-restart-verify "${network}" "${database_name}" "${resource_owner}" \
    TestGS9DRestartQualification \
    WORKFLOW_CONTROL_GS9D_RESTART_PHASE=verify \
    "WORKFLOW_CONTROL_GS9D_RESTART_SCHEMA=${restart_schema}"
}

run_workflow_budget_authority_test_container() {
  local resource_prefix="$1"
  local label="$2"
  local network="$3"
  local database_name="$4"
  local resource_owner="$5"
  local test_name="$6"
  shift 6
  local container="${resource_prefix}-qualification-${label}"
  local repository_mount
  repository_mount="$(docker_path "${staged_repository_dir}")"
  load_workflow_budget_qualification_fixture
  local -a run_args=(
    run --rm --pull=never
    --name "${container}"
    --label "com.openslack.go-check.run=${resource_owner}"
    --network "${network}"
    --env GOTOOLCHAIN=local
    --env GOWORK=off
    --env GOMODCACHE=/go/pkg/mod
    --env GOCACHE=/root/.cache/go-build
    --env "DATABASE_URL=postgres://openslack:openslack-go-check@postgres:5432/${database_name}?sslmode=disable"
    --env WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE=local-qualification-v1
    --env WORKFLOW_CONTROL_BUDGET_AUTHORITY_HTTP_BIND=127.0.0.1:8085
    --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_SERVICE_BUILD_SHA=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_SERVICE_BUILD_SHA}"
    --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_BEARER_TOKEN_SHA256=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_BEARER_TOKEN_SHA256}"
    --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_WORKSPACE_ID=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_WORKSPACE_ID}"
    --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_CALLER_ID=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_CALLER_ID}"
    --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH}"
    --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH}"
    --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS}"
    --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD}"
    --env "WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS=${WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS}"
    --mount "type=bind,source=${repository_mount},target=/source,readonly"
    --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod"
    --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build"
    --workdir /source/services/workflow-control
  )
  cleanup_containers+=("${resource_owner}|${container}")
  while (($#)); do
    run_args+=(--env "$1")
    shift
  done
  docker_cmd_interruptible "${run_args[@]}" "${GO_IMAGE}" \
    go test -race ./cmd/budget-authority-server -run "^${test_name}$" -count=1
}

run_workflow_budget_authority_qualification() {
  local resource_prefix="$1"
  local network="$2"
  local database_container="$3"
  local database_name="$4"
  local resource_owner="$5"
  local run_token="$6"
  local restart_token="${run_token,,}"
  local restart_schema="workflow_control_gs9e_restart_${restart_token//-/}"

  log "qualifying Workflow Control GS9-E PostgreSQL budget authority and failure bounds"
  run_workflow_budget_authority_test_container \
    "${resource_prefix}" budget-bounds "${network}" "${database_name}" "${resource_owner}" \
    TestGS9EQualification \
    WORKFLOW_CONTROL_GS9E_QUALIFICATION=1

  log "seeding Workflow Control GS9-E budget ledger restart qualification"
  run_workflow_budget_authority_test_container \
    "${resource_prefix}" budget-restart-seed "${network}" "${database_name}" "${resource_owner}" \
    TestGS9ERestartQualification \
    WORKFLOW_CONTROL_GS9E_RESTART_PHASE=seed \
    "WORKFLOW_CONTROL_GS9E_RESTART_SCHEMA=${restart_schema}"

  require_resource_owned container "${database_container}" "${resource_owner}"
  docker_cmd_interruptible restart "${database_container}" >/dev/null
  wait_for_healthy_container "${database_container}" "PostgreSQL after GS9-E budget authority restart"

  log "verifying Workflow Control GS9-E durable budget ledger after PostgreSQL restart"
  run_workflow_budget_authority_test_container \
    "${resource_prefix}" budget-restart-verify "${network}" "${database_name}" "${resource_owner}" \
    TestGS9ERestartQualification \
    WORKFLOW_CONTROL_GS9E_RESTART_PHASE=verify \
    "WORKFLOW_CONTROL_GS9E_RESTART_SCHEMA=${restart_schema}"
}

run_prometheus_gate() {
  local module_dir="$1"
  require_image "${PROMETHEUS_IMAGE}"

  local prometheus_mount
  prometheus_mount="$(docker_path "${module_dir}/deploy/prometheus")"
  docker_cmd_interruptible run --rm --pull=never \
    --entrypoint promtool \
    --mount "type=bind,source=${prometheus_mount},target=/etc/prometheus,readonly" \
    "${PROMETHEUS_IMAGE}" \
    check config /etc/prometheus/prometheus.yml
  docker_cmd_interruptible run --rm --pull=never \
    --entrypoint promtool \
    --workdir /etc/prometheus \
    --mount "type=bind,source=${prometheus_mount},target=/etc/prometheus,readonly" \
    "${PROMETHEUS_IMAGE}" \
    test rules rules.test.yml
}

run_distribution_gate() {
  local module_dir="$1"
  local image_tag="$2"
  local docker_target="$3"
  local resource_owner="$4"
  local module_mount
  module_mount="$(docker_path "${module_dir}")"

  if docker_cmd image inspect "${image_tag}" >/dev/null 2>&1; then
    fail "refusing to replace an existing verification image: ${image_tag}"
  fi
  cleanup_images+=("${resource_owner}|${image_tag}")
  docker_cmd_interruptible build \
    --pull=false \
    --label "com.openslack.go-check.run=${resource_owner}" \
    --target "${docker_target}" \
    --tag "${image_tag}" \
    "${module_mount}"
  require_resource_owned image "${image_tag}" "${resource_owner}"
}

run_workflow_authority_image_default_off() {
  local resource_prefix="$1"
  local image_tag="$2"
  local resource_owner="$3"
  local authority_container="${resource_prefix}-authority-default-off"
  local test_container="${resource_prefix}-qualification-authority-image-default-off"
  local repository_mount
  repository_mount="$(docker_path "${staged_repository_dir}")"

  cleanup_containers+=("${resource_owner}|${authority_container}")
  docker_cmd_interruptible run -d --pull=never \
    --name "${authority_container}" \
    --label "com.openslack.go-check.run=${resource_owner}" \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    --network none \
    --health-cmd 'kill -0 1' \
    --health-interval 1s \
    --health-timeout 1s \
    --health-retries 30 \
    --entrypoint /authority-server \
    "${image_tag}" >/dev/null
  require_resource_owned container "${authority_container}" "${resource_owner}"
  wait_for_healthy_container "${authority_container}" "Workflow Control authority default-off"

  cleanup_containers+=("${resource_owner}|${test_container}")
  docker_cmd_interruptible run --rm --pull=never \
    --name "${test_container}" \
    --label "com.openslack.go-check.run=${resource_owner}" \
    --network "container:${authority_container}" \
    --env GOTOOLCHAIN=local \
    --env GOWORK=off \
    --env GOMODCACHE=/go/pkg/mod \
    --env GOCACHE=/root/.cache/go-build \
    --env WORKFLOW_CONTROL_GS9B_DEFAULT_ORIGIN=http://127.0.0.1:8082 \
    --mount "type=bind,source=${repository_mount},target=/source,readonly" \
    --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod" \
    --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build" \
    --workdir /source/services/workflow-control \
    "${GO_IMAGE}" \
    go test -race ./cmd/authority-server -run '^TestGS9BImageDefaultOff$' -count=1
}

run_workflow_checkpoint_shadow_image_default_off() {
  local resource_prefix="$1"
  local image_tag="$2"
  local resource_owner="$3"
  local checkpoint_container="${resource_prefix}-checkpoint-shadow-default-off"
  local test_container="${resource_prefix}-qualification-checkpoint-image-default-off"
  local repository_mount
  repository_mount="$(docker_path "${staged_repository_dir}")"

  cleanup_containers+=("${resource_owner}|${checkpoint_container}")
  docker_cmd_interruptible run -d --pull=never \
    --name "${checkpoint_container}" \
    --label "com.openslack.go-check.run=${resource_owner}" \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    --network none \
    --health-cmd 'kill -0 1' \
    --health-interval 1s \
    --health-timeout 1s \
    --health-retries 30 \
    --entrypoint /checkpoint-shadow-server \
    "${image_tag}" >/dev/null
  require_resource_owned container "${checkpoint_container}" "${resource_owner}"
  wait_for_healthy_container "${checkpoint_container}" "Workflow Control checkpoint shadow default-off"

  cleanup_containers+=("${resource_owner}|${test_container}")
  docker_cmd_interruptible run --rm --pull=never \
    --name "${test_container}" \
    --label "com.openslack.go-check.run=${resource_owner}" \
    --network "container:${checkpoint_container}" \
    --env GOTOOLCHAIN=local \
    --env GOWORK=off \
    --env GOMODCACHE=/go/pkg/mod \
    --env GOCACHE=/root/.cache/go-build \
    --env WORKFLOW_CONTROL_GS9C_DEFAULT_ORIGIN=http://127.0.0.1:8083 \
    --mount "type=bind,source=${repository_mount},target=/source,readonly" \
    --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod" \
    --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build" \
    --workdir /source/services/workflow-control \
    "${GO_IMAGE}" \
    go test -race ./cmd/checkpoint-shadow-server -run '^TestGS9CImageDefaultOff$' -count=1
}

run_workflow_effect_shadow_image_default_off() {
  local resource_prefix="$1"
  local image_tag="$2"
  local resource_owner="$3"
  local effect_container="${resource_prefix}-effect-shadow-default-off"
  local test_container="${resource_prefix}-qualification-effect-image-default-off"
  local repository_mount
  repository_mount="$(docker_path "${staged_repository_dir}")"

  cleanup_containers+=("${resource_owner}|${effect_container}")
  docker_cmd_interruptible run -d --pull=never \
    --name "${effect_container}" \
    --label "com.openslack.go-check.run=${resource_owner}" \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    --network none \
    --health-cmd 'kill -0 1' \
    --health-interval 1s \
    --health-timeout 1s \
    --health-retries 30 \
    --entrypoint /effect-shadow-server \
    "${image_tag}" >/dev/null
  require_resource_owned container "${effect_container}" "${resource_owner}"
  wait_for_healthy_container "${effect_container}" "Workflow Control effect shadow default-off"

  cleanup_containers+=("${resource_owner}|${test_container}")
  docker_cmd_interruptible run --rm --pull=never \
    --name "${test_container}" \
    --label "com.openslack.go-check.run=${resource_owner}" \
    --network "container:${effect_container}" \
    --env GOTOOLCHAIN=local \
    --env GOWORK=off \
    --env GOMODCACHE=/go/pkg/mod \
    --env GOCACHE=/root/.cache/go-build \
    --env WORKFLOW_CONTROL_GS9D_DEFAULT_ORIGIN=http://127.0.0.1:8084 \
    --mount "type=bind,source=${repository_mount},target=/source,readonly" \
    --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod" \
    --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build" \
    --workdir /source/services/workflow-control \
    "${GO_IMAGE}" \
    go test -race ./cmd/effect-shadow-server -run '^TestGS9DImageDefaultOff$' -count=1
}

run_workflow_budget_authority_image_default_off() {
  local resource_prefix="$1"
  local image_tag="$2"
  local resource_owner="$3"
  local budget_container="${resource_prefix}-budget-authority-default-off"
  local test_container="${resource_prefix}-qualification-budget-image-default-off"
  local repository_mount
  repository_mount="$(docker_path "${staged_repository_dir}")"

  cleanup_containers+=("${resource_owner}|${budget_container}")
  docker_cmd_interruptible run -d --pull=never \
    --name "${budget_container}" \
    --label "com.openslack.go-check.run=${resource_owner}" \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    --network none \
    --health-cmd 'kill -0 1' \
    --health-interval 1s \
    --health-timeout 1s \
    --health-retries 30 \
    --entrypoint /budget-authority-server \
    "${image_tag}" >/dev/null
  require_resource_owned container "${budget_container}" "${resource_owner}"
  wait_for_healthy_container "${budget_container}" "Workflow Control budget authority default-off"

  cleanup_containers+=("${resource_owner}|${test_container}")
  docker_cmd_interruptible run --rm --pull=never \
    --name "${test_container}" \
    --label "com.openslack.go-check.run=${resource_owner}" \
    --network "container:${budget_container}" \
    --env GOTOOLCHAIN=local \
    --env GOWORK=off \
    --env GOMODCACHE=/go/pkg/mod \
    --env GOCACHE=/root/.cache/go-build \
    --env WORKFLOW_CONTROL_GS9E_DEFAULT_ORIGIN=http://127.0.0.1:8085 \
    --mount "type=bind,source=${repository_mount},target=/source,readonly" \
    --mount "type=volume,source=${MOD_CACHE_VOLUME},target=/go/pkg/mod" \
    --mount "type=volume,source=${BUILD_CACHE_VOLUME},target=/root/.cache/go-build" \
    --workdir /source/services/workflow-control \
    "${GO_IMAGE}" \
    go test -race ./cmd/budget-authority-server -run '^TestGS9EImageDefaultOff$' -count=1
}

run_http_smoke() {
  local resource_prefix="$1"
  local image_tag="$2"
  local network="$3"
  local database_name="$4"
  local has_database="$5"
  local runtime_profile="$6"
  local resource_owner="$7"
  local app_container="${resource_prefix}-app"
  local app_network_alias="application"
  local -a run_args=(
    run -d
    --pull=never
    --name "${app_container}"
    --label "com.openslack.go-check.run=${resource_owner}"
    --read-only
    --tmpfs /tmp:rw,noexec,nosuid,size=16m
  )

  if ((has_database)); then
    run_args+=(
      --network "${network}"
      --network-alias "${app_network_alias}"
      --env "DATABASE_URL=postgres://openslack:openslack-go-check@postgres:5432/${database_name}?sslmode=disable"
      --env MIGRATION_SOURCE=/migrations
    )
  fi
  if [[ "${runtime_profile}" == "notification-delivery-v1" ]]; then
    run_args+=(
      --env 'NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      --env 'API_KEY_PEPPER_ACTIVE={"id":"v1","value":"ci-active-pepper"}'
      --env 'API_KEY_PEPPER_PREVIOUS={"id":"v0","value":"ci-previous-pepper"}'
      --env ENV_CREDENTIAL_ALLOWLIST=VENDOR_TEST_TOKEN
      --env CREDENTIAL_REF_SCHEME_ALLOWLIST=env
      --env CREDENTIAL_PROFILE_VALIDATOR=bearer-env-v1
    )
  elif [[ "${runtime_profile}" == "organization-graph-v1" ]]; then
    run_args+=(
      --env 'GRAPH_QUERY_CURSOR_SECRET=organization-graph-go-check-cursor-secret-v1'
      --env 'GRAPH_QUERY_CURSOR_SECRET_PREVIOUS=organization-graph-go-check-cursor-secret-v0'
      --env 'GRAPH_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      --env GRAPH_HTTP_BIND=:8080
      --env GRAPH_NETWORK_MODE=internal
    )
  elif [[ "${runtime_profile}" == "governance-control-v1" ||
    "${runtime_profile}" == "governance-control-v2" ]]; then
    run_args+=(
      --env 'GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      --env GOVERNANCE_HTTP_BIND=:8080
      --env GOVERNANCE_NETWORK_MODE=internal
    )
    if [[ "${runtime_profile}" == "governance-control-v2" ]]; then
      run_args+=(
        --env GOVERNANCE_AUTHORITY_MODE=local-qualification-v1
        --env GOVERNANCE_AUTHORITY_WORKSPACE_ID=workspace.demo
        --env GOVERNANCE_AUTHORITY_CALLER_ID=typescript:qoder-mcp
        --env GOVERNANCE_AUTHORITY_ROUTING_EPOCH=7
        --env GOVERNANCE_AUTHORITY_ACCEPT_NEW_RECORDS=true
        --env GOVERNANCE_AUTHORITY_DRAIN_EPOCHS=6
      )
    fi
  elif [[ "${runtime_profile}" == "workflow-control-shadow-v1" ||
    "${runtime_profile}" == "workflow-control-runner-v1" ||
    "${runtime_profile}" == "workflow-control-authority-v2" ||
    "${runtime_profile}" == "workflow-control-checkpoint-shadow-v1" ||
    "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
    "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
    run_args+=(
      --env 'WORKFLOW_CONTROL_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      --env WORKFLOW_CONTROL_HTTP_BIND=:8080
      --env WORKFLOW_CONTROL_NETWORK_MODE=internal
    )
  else
    fail "HTTP smoke has no reviewed runtime profile"
  fi

  cleanup_containers+=("${resource_owner}|${app_container}")
  docker_cmd_interruptible "${run_args[@]}" "${image_tag}" >/dev/null
  require_resource_owned container "${app_container}" "${resource_owner}"
  wait_for_healthy_container "${app_container}" "application"
  if [[ "${runtime_profile}" == "governance-control-v1" ||
    "${runtime_profile}" == "governance-control-v2" ]]; then
    local expected_authority_enabled=false
    if [[ "${runtime_profile}" == "governance-control-v2" ]]; then
      expected_authority_enabled=true
    fi
    log "verifying Governance Control image health and version responses"
    run_governance_control_test_container \
      "${resource_prefix}" image-smoke "${network}" "${database_name}" "${resource_owner}" \
      "GOVERNANCE_GS5_SMOKE_ORIGIN=http://${app_network_alias}:8080" \
      "GOVERNANCE_GS5_EXPECT_AUTHORITY_ENABLED=${expected_authority_enabled}"
    if [[ "${runtime_profile}" == "governance-control-v2" ]]; then
      log "verifying Governance Control GS6 authority image responses"
      run_governance_control_authority_test_container \
        "${resource_prefix}" authority-image-smoke "${network}" "${database_name}" "${resource_owner}" \
        TestGS6ImageSmoke \
        "GOVERNANCE_GS6_SMOKE_ORIGIN=http://${app_network_alias}:8080"
    fi
  elif [[ "${runtime_profile}" == "workflow-control-shadow-v1" ||
    "${runtime_profile}" == "workflow-control-runner-v1" ||
    "${runtime_profile}" == "workflow-control-authority-v2" ||
    "${runtime_profile}" == "workflow-control-checkpoint-shadow-v1" ||
    "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
    "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
    log "verifying Workflow Control GS7-B image API responses"
    run_workflow_control_test_container \
      "${resource_prefix}" image-smoke "${network}" "${database_name}" "${resource_owner}" \
      TestGS7BImageSmoke \
      "WORKFLOW_CONTROL_GS7B_SMOKE_ORIGIN=http://${app_network_alias}:8080"
    if [[ "${runtime_profile}" == "workflow-control-runner-v1" ||
      "${runtime_profile}" == "workflow-control-authority-v2" ||
      "${runtime_profile}" == "workflow-control-checkpoint-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
      log "verifying Workflow Control GS8-B default image keeps runner disabled"
      run_workflow_runner_test_container \
        "${resource_prefix}" runner-image-default-off "${network}" "${database_name}" "${resource_owner}" \
        ./cmd/runner-server TestGS8BImageDefaultOff 1 \
        "WORKFLOW_RUNNER_GS8B_DEFAULT_ORIGIN=http://${app_network_alias}:8080"
    fi
    if [[ "${runtime_profile}" == "workflow-control-authority-v2" ||
      "${runtime_profile}" == "workflow-control-checkpoint-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
      log "verifying Workflow Control GS9-B authority image defaults to mutation-off"
      run_workflow_authority_image_default_off \
        "${resource_prefix}" "${image_tag}" "${resource_owner}"
    fi
    if [[ "${runtime_profile}" == "workflow-control-checkpoint-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
      log "verifying Workflow Control GS9-C checkpoint shadow image defaults to observation-off"
      run_workflow_checkpoint_shadow_image_default_off \
        "${resource_prefix}" "${image_tag}" "${resource_owner}"
    fi
    if [[ "${runtime_profile}" == "workflow-control-effect-shadow-v1" ||
      "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
      log "verifying Workflow Control GS9-D effect shadow image defaults to observation-off"
      run_workflow_effect_shadow_image_default_off \
        "${resource_prefix}" "${image_tag}" "${resource_owner}"
    fi
    if [[ "${runtime_profile}" == "workflow-control-budget-authority-v1" ]]; then
      log "verifying Workflow Control GS9-E budget authority image defaults to mutation-off"
      run_workflow_budget_authority_image_default_off \
        "${resource_prefix}" "${image_tag}" "${resource_owner}"
    fi
  fi
}

main() {
  if (($# != 1)); then
    usage
    exit 2
  fi
  local requested="$1"
  if [[ "${requested}" != "--all" && ! "${requested}" =~ ^services/[a-z0-9][a-z0-9-]*$ ]]; then
    usage
    fail "expected services/<name> or --all"
  fi

  detect_host_runtime
  preflight_repository
  preflight_docker
  load_workspace_modules

  if [[ "${requested}" == "--all" ]]; then
    stage_repository_snapshot
    local module
    for module in "${workspace_modules[@]}"; do
      run_module_gate "${module#./}"
    done
  else
    validate_module_path "${requested}"
    module_in_workspace "${requested}" ||
      fail "requested module is not registered in go.work: ${requested}"
    stage_repository_snapshot
    run_module_gate "${requested}"
  fi
}

main "$@"
