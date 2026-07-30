#!/bin/sh

set -eu

if [ "$#" -ne 2 ]; then
  printf '%s\n' 'go-check container gate: expected source and work directories' >&2
  exit 2
fi

readonly source_dir="$1"
readonly work_dir="$2"
readonly expected_go_version='go1.26.5'
readonly expected_module="${GO_CHECK_EXPECTED_MODULE:?GO_CHECK_EXPECTED_MODULE is required}"
readonly module_relative_path="${GO_CHECK_MODULE_RELATIVE_PATH:?GO_CHECK_MODULE_RELATIVE_PATH is required}"

module_name="${module_relative_path#services/}"
case "${module_relative_path}" in
  services/*) ;;
  *)
    printf '%s\n' 'go-check: invalid module-relative path' >&2
    exit 1
    ;;
esac
case "${module_name}" in
  '' | */* | *[!a-z0-9-]* | -*)
    printf '%s\n' 'go-check: invalid module-relative path' >&2
    exit 1
    ;;
esac
if [ "${#module_name}" -gt 48 ]; then
  printf '%s\n' 'go-check: invalid module-relative path' >&2
  exit 1
fi

test -f "${source_dir}/${module_relative_path}/go.mod"
test -f "${source_dir}/${module_relative_path}/go.sum"

test "$(go env GOWORK)" = 'off'
test "$(go env GOVERSION)" = "${expected_go_version}"
test "$(go env GOMODCACHE)" = '/go/pkg/mod'
test "$(go env GOCACHE)" = '/root/.cache/go-build'

mkdir -p "${work_dir}/repository"
cp -a "${source_dir}/." "${work_dir}/repository/"
cd "${work_dir}/repository/${module_relative_path}"

test "$(go list -m -f '{{.Path}}')" = "${expected_module}"
test "$(go list -m -f '{{.GoVersion}}')" = '1.26.5'
go mod verify

cp go.mod "${work_dir}/original.go.mod"
cp go.sum "${work_dir}/original.go.sum"
go mod tidy
cmp -s go.mod "${work_dir}/original.go.mod" || {
  printf '%s\n' 'go-check: go mod tidy changed go.mod' >&2
  exit 1
}
cmp -s go.sum "${work_dir}/original.go.sum" || {
  printf '%s\n' 'go-check: go mod tidy changed go.sum' >&2
  exit 1
}

unformatted="$(gofmt -l .)"
if [ -n "${unformatted}" ]; then
  printf '%s\n' "${unformatted}" >&2
  exit 1
fi

go build ./...
go vet ./...

if [ -n "${DATABASE_URL:-}" ]; then
  migrate_version="$(go list -m -f '{{.Version}}' github.com/golang-migrate/migrate/v4)"
  case "${migrate_version}" in
    v[0-9]*) ;;
    *)
      printf '%s\n' 'go-check: invalid golang-migrate version' >&2
      exit 1
      ;;
  esac
  go install -tags pgx5 "github.com/golang-migrate/migrate/v4/cmd/migrate@${migrate_version}"
  migrate -path migrations -database "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is required}" up
fi

go test -race ./...
if [ -n "${DATABASE_URL:-}" ]; then
  go test -race ./... -count=5
fi
