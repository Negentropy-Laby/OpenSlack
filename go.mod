// rc_wsman - module manifest (Pre-Implementation CP0 skeleton).
//
// AUTHORED-BUT-NOT-TIDIED. The local development shell has no Go toolchain
// (`go: command not found`), so `go mod tidy` has not run and there is
// intentionally NO go.sum. Both are generated in a Go-equipped environment
// (locally or in CI - see .github/workflows/tests.yml).
//
// Dependency intents (majors pinned per standards/technical-preferences.md;
// exact patches resolved at Implementation time "without changing the accepted
// majors", per technical-preferences.md lines 27-28). These modules enter the
// require block - with go.sum entries - when their importing code lands and
// `go mod tidy` runs:
//
//	github.com/go-chi/chi/v5             v5   HTTP router
//	github.com/jackc/pgx/v5              v5   PostgreSQL driver
//	github.com/golang-migrate/migrate/v4 v4   migration tool
//	github.com/prometheus/client_golang  v1   metrics
//
// Consistency note: this manifest complies with technical-preferences.md:27-28
// as written - sentence 1 forbids the file only "in the documentation phase"
// (CP0 is past that, in Pre-Implementation); sentence 2 forbids exact patches
// until implementation authorization (this skeleton is majors-only: no require,
// no go.sum, so no patches are recorded). Gate 1's Test Framework Baseline also
// independently requires a go.mod. The baseline (full-jitter leaf + unit test in
// internal/delivery) is stdlib-only and needs none of the above.

module rc_wsman

go 1.26.5
