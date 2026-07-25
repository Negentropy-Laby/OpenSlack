# Test Layout

> Implementation-stage test corpus; CP0 established the original framework baseline.

## Strategy

Go unit tests are **co-located** with source as `*_test.go` (Go convention). The
`tests/` tree holds integration-test harnesses, shared fixtures, and test tooling
that do not belong next to a single package.

## Baseline

The Test Framework Baseline's "≥1 runnable test" is
[`../internal/delivery/backoff_test.go`](../internal/delivery/backoff_test.go),
exercising the full-jitter backoff leaf
([`../internal/delivery/backoff.go`](../internal/delivery/backoff.go)) per
[design/cdd/delivery.md](../design/cdd/delivery.md) (lines 90-101). It is
stdlib-only, so it compiles against the minimal `go.mod` before any external
dependency is resolved.

## Tree

| Path | Purpose | Status |
|---|---|---|
| `unit/` | Reserved for cross-package unit-test harness / shared fakes. | skeleton (`.gitkeep`); Go unit tests live next to source. |
| `contracts/` | CDD AC evidence, OpenAPI, registries, links, manifest and Prometheus artifact checks. | implemented |
| `integration/` | DB-backed + HTTP-server integration tests (real PostgreSQL, chi router, safe transport). | implemented |

## Running

```
go test -race ./...
```

CI: [`.github/workflows/tests.yml`](../.github/workflows/tests.yml) is configured to run
`go mod tidy`, `go vet ./...`, and `go test -race ./...` on push and pull request. The current acceptance evidence is
from the local Go 1.26.5/PostgreSQL 18.4 environment; no GitHub-hosted Actions run is claimed.
