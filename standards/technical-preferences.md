# Technical Preferences

> **Status**: Approved implementation baseline
> **Domain**: internal headless API/worker service
> **Last verified**: 2026-07-22

## Version Baseline

| Layer | Decision | Pinning policy |
|---|---|---|
| Language | Go 1.26.5 | exact toolchain patch |
| Database | PostgreSQL 18.4 | exact server minor; follow supported minor security updates |
| HTTP router | `go-chi/chi` v5.2.0 | exact module patch in `go.mod`/`go.sum` |
| PostgreSQL driver | `jackc/pgx` v5.7.1 | exact module patch in `go.mod`/`go.sum` |
| Migration tool | `golang-migrate/migrate` v4.18.1 | exact module patch in `go.mod`/`go.sum` |
| Metrics | Prometheus server v3.13.1 | Compose image pinned by tag and digest; service emits the text exposition directly |
| API contract | OpenAPI 3.1 | `docs/api/openapi.yaml` is the implemented public-wire authority |

Official verification sources:

- Go: <https://go.dev/dl/>
- PostgreSQL support/minors: <https://www.postgresql.org/support/versioning/>
- chi releases: <https://github.com/go-chi/chi/releases>
- pgx releases: <https://github.com/jackc/pgx/releases>
- migrate releases: <https://github.com/golang-migrate/migrate/releases>

Implementation dependencies are fixed in `go.mod`/`go.sum`; deployable PostgreSQL and Prometheus images are fixed
by tag and immutable digest in `docker-compose.yml`.

## Deployment Shape

- One Go binary and one process for MVP.
- One deployment unit owns HTTP API, Delivery workers, lease recovery, reliability collection, liveness/readiness
  and graceful shutdown.
- Six CDD modules are packages/interfaces, not processes or network services.
- PostgreSQL is the only persistent state and coordination authority.
- No Redis, Kafka/RabbitMQ, external scheduler, independent DLQ, service mesh or sidecar is required.

## Package Boundaries

| Logical package | Allowed dependencies |
|---|---|
| `calleraccess` | shared value types, credential digest/limiter ports |
| `vendorregistry` | shared value types, PostgreSQL repository port |
| `notificationstore` | shared value types, PostgreSQL repository port |
| `delivery` | Store/Registry interfaces, secret resolver, safe HTTP transport |
| `operations` | Caller Access and Store interfaces |
| `observability` | global Store projection and metrics sink |
| `app` | composition only; may construct typed contexts and lifecycle components |

Domain packages must not import HTTP routing, PostgreSQL concrete types or each other except through the approved
interfaces. `app` is the only composition root.

## Go Conventions

- `context.Context` is the first parameter of every blocking operation; never store it in structs.
- Errors crossing a module boundary are closed typed categories; text is diagnostic only.
- Time is obtained through an injected clock or PostgreSQL transaction time where the CDD requires Store authority.
- IDs are opaque strings at API boundaries and strong aliases internally.
- `log/slog` structured logs; secrets, payload, response bodies, raw API keys and credential locators are forbidden.
- Goroutines start only from lifecycle owners and must stop during graceful shutdown.
- SQL is explicit and reviewed; no ORM. Transactions live in repository methods that own the atomic invariant.

## Security Defaults

- Inbound TLS is terminated by the deployment boundary; plaintext public ingress is forbidden.
- API keys are 256-bit random values, represented as `key_id.secret`; store only HMAC-SHA-256 digests using a
  deployment pepper (versioned via `pepper_id`; see ADR-0003) and compare in constant time.
- Outbound HTTP uses a dedicated safe transport: environment proxy disabled, redirects rejected, validated/pinned
  IP dial, original hostname TLS verification, hard timeout, no response-body consumption.
- MVP credential scheme is `env://NAME`; Registry stores only the opaque reference and Delivery resolves from a
  startup allowlist. Arbitrary environment names and filesystem paths are forbidden.

## Quality Rules

- `gofmt`, `go vet`, race-enabled concurrency tests and static analysis are required once code exists.
- Contract tests derive from CDD AC and OpenAPI; migrations require forward and rollback verification.
- No numeric latency/throughput SLA is approved before measurements. Implementation must record the environment,
  dataset, concurrency and percentile method for the first baseline.

## Forbidden Patterns

- Database write plus direct message-queue publish in one request path.
- Unbounded retry, automatic dead replay, lease renewal or local fallback state.
- Dynamic outbound URL/proxy/redirect behavior.
- Cross-module direct table writes.
- Logging or metric labels containing payload, secret, credential reference or unbounded vendor/error values.
- Treating the six logical modules as six microservices in MVP.
