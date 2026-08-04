# GS8-B Runner Operations

The default image starts `/server` and keeps runner control disabled. To operate `/runner-server`,
first apply migrations through version 2, pre-create an owner-only descriptor root, build the
TypeScript package, and create a bundle manifest matching
`openslack.workflow_runner_bundle.v1`. Record the manifest SHA-256 outside the bundle and pass it
through the required runner environment documented in the service README. The bundle directory
must contain only `workflow-runner-bundle.v1.json`, `runner-node`, and the self-contained
`workflow-runner-worker.js`; build or stage it atomically and never modify it in place. When the
container entry point is `/runner-server`, set
`WORKFLOW_CONTROL_HEALTH_URL=http://127.0.0.1:8081/health/ready` so the image health check follows
the runner listener.

Only one runner-server may own a workspace. A dedicated PostgreSQL advisory lock enforces this for
the process lifetime. Each boot derives a new supervisor identity, allowing startup recovery to
distinguish old attempts. Readiness requires database access and exact schema version 2.

Operational handling is fail closed:

- `reconciliation_required`: stop automatic replay and inspect the runner reconciliation record;
- repeated pre-execution dispatch failure: observe the durable 250 ms exponential backoff; after
  five failures the record is dead/reconciliation-required and needs operator inspection;
- expired lease: verify current fence and process termination before allowing recovery;
- stale fence: terminate the old process and preserve the higher-fence attempt;
- process crash or forced termination: inspect whether JavaScript started and whether an effect
  boundary was open;
- bundle or descriptor hash drift: reject startup or the lease; do not overwrite the artifact.

The metrics endpoint is authenticated and workspace-bound. When runner control is enabled, add it
as a separate Prometheus target and load the supplied runner alerts. Logs must use bounded IDs and
codes; never log the bearer token, descriptor content, workflow input, prompt, transcript, or
provider payload.
