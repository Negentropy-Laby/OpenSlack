# GS9-B Qualification

GS9-B adds an isolated Go/PostgreSQL Workflow Control authority spine behind the only accepted
runtime switch `WORKFLOW_CONTROL_AUTHORITY_MODE=local-qualification-v1`. The normal image and an
authority-server process started without that value remain mutation-off. TypeScript continues to
own production Workflow Control records and user-visible reads; this batch does not activate a
new-record route or permit per-request fallback between writers.

## Reviewed local gate

The reviewed Go verifier classifies Workflow Control with runtime profile
`workflow-control-authority-v2`. That profile is a strict superset: it retains every GS7-B shadow
qualification, every GS8-B runner qualification, pinned Go and PostgreSQL images, `GOWORK=off`,
race tests, migrations, Prometheus, distribution, and the existing default-off runner image smoke
before adding GS9-B authority evidence.

The GS9-B PostgreSQL bounds run through `TestGS9BQualification` and the underlying
`internal/authoritystore/...` suite. Together they must prove:

1. exact byte-identical replay returns the original durable receipt, while one idempotency key with
   a different fingerprint is rejected without changing the authority head;
2. stale revision/CAS, immutable-route drift, non-canonical input, and invalid state transitions
   fail closed without changing the accepted route or head;
3. each accepted mutation commits its run head, transition event, receipt, and pending outbox in one
   transaction: the first accept has exact cardinality `1/1/1/1`, and one accepted transition has
   exact cumulative cardinality `1/2/2/2`;
4. concurrent transitions at one revision have exactly one durable winner and one conflict;
5. a simulated response loss after commit converges to the exact committed receipt;
6. an unknown commit persists a stable byte-identical reconciliation receipt without advancing the
   authority head or creating event/outbox evidence;
7. a second unknown outcome while writing reconciliation returns the same closed non-2xx authority
   error contract, never invents a receipt, and leaves all authoritative cardinalities at zero;
8. immutable triggers cover authority epoch, transition event, receipt, reconciliation, and prior
   GS7/GS8 evidence tables; migration qualification locks the expected trigger-event count;
9. GS9-B authority tables stay in their own namespace, do not acquire checkpoint, approval, budget,
   effect, job, attempt, lease, or fence authority, and the down migration removes only an empty
   authority namespace while refusing a registered epoch; and
10. the normal `cmd/server` remains the mutation-free GS7-B shadow surface, while a default
    `cmd/authority-server` exposes health, metrics, and version only.

`TestGS9BRestartQualification` uses separate seed and verify processes around a real PostgreSQL
container restart. The verify phase must recover the exact record, receipt, route, revision, and
reconciliation evidence created by the seed phase; process memory is not qualification evidence.

The built-image gate starts `/authority-server` with no authority mode or credentials on an
isolated container network. `TestGS9BImageDefaultOff` shares only that network namespace and proves
that health and version remain available while `/v1/workflow-control/runs:accept` returns `404`.
The smoke does not publish a host port and does not set database, bearer, workspace, caller, build,
or routing-epoch authority configuration.

The retained GS7-B image and handler gates separately prove that the image's default `/server`
entrypoint still exposes only the observational shadow routes and returns `404` for every GS9-B
authority mutation path.

Run the complete reviewed qualification from the repository root:

```bash
bash scripts/go-check.sh services/workflow-control
```

Hosted CI repeats the GS9-B authority store and named server qualifications against the exact
PostgreSQL 18.4 digest, including the database restart, before running the full reviewed workspace
verifier. A skipped test, unpinned image, missing `-race`, non-`off` Go workspace, or removal of a
GS7/GS8 gate is a qualification failure.

## Evidence ceiling

Passing these gates is `GS9-B LOCAL_PASS` for the isolated authority spine only. It does not prove
TypeScript-to-Go differential parity, a user-visible Go read path, active new-record routing,
checkpoint/resume runtime delivery, workflow-effect execution, cumulative provider-budget
enforcement, a production canary, higher-epoch rollback, old-record migration, TypeScript writer
deletion, authenticated Qoder Desktop, remote Connector/OAuth, live deployment, release,
production readiness, review closure, or independent human approval. Those remain separate later
stages and evidence claims.
