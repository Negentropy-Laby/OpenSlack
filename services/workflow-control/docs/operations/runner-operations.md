# Workflow Runner Operations

## GS9-I upgrade

The current gate uses `workflow-control-runner-v2-runtime-delivery-v1`. The six
retired runner, authority, checkpoint-shadow, effect-shadow, budget-authority,
and F1 foundation entry profiles are rejected with this replacement named in the
error. Their applicable component checks remain in the current gate.

Before starting an upgraded `/runner-server`, remove
`WORKFLOW_RUNNER_CONTROL_V2_QUALIFICATION_ENABLED` and every variable with prefix
`WORKFLOW_RUNNER_CONTROL_CHECKPOINT_SHADOW_` or
`WORKFLOW_RUNNER_CONTROL_EFFECT_SHADOW_` from the host service environment. Even
an empty value or `ENABLED=0` still supplies a retired name and fails startup with
`workflow_runner_control_config_failed` / `CONFIG_INVALID`. Configure the sealed
Go-v2 runtime-delivery and run-authority bindings from the service README instead.
The legacy shadow components described below remain qualification evidence, not
alternative runner execution modes.

Legacy `pendingAgentControls` / `stopAgent` records remain parseable for historical
inspection. They no longer control a running agent. A Go resume carrying pending
legacy controls is rejected as `WORKFLOW_RESUME_RECOVERY_REQUIRED` before its
generation advances or an agent launches. Preserve that evidence for reconciliation;
do not edit a recovery projection to simulate an operator control or clear a blocker.

The current restart gate covers safe, running, open-effect, and pending-cancel
orphans using new Go process and PostgreSQL postmaster identities. Only the safe
unstarted job can receive a new attempt and exactly incremented fence.

## Runtime and retained qualification components

The default image starts `/server` and keeps runner control disabled. To operate `/runner-server`,
first apply the reviewed migration chain for the selected schema profile, pre-create an owner-only descriptor root, build the
TypeScript package, and create a bundle manifest matching
`openslack.workflow_runner_bundle.v1`. Record the manifest SHA-256 outside the bundle and pass it
through the required runner environment documented in the service README. The bundle directory
must contain only `workflow-runner-bundle.v1.json`, `runner-node`, and the self-contained
`workflow-runner-worker.cjs`; its suffix fixes the file's CommonJS parse mode even below a
`type: module` ancestor. Create it with
`bun scripts/qualification/workflow-runner-bundle.ts stage --bundle-root <absolute-root> --node-executable <absolute-node>`,
then publish the directory atomically and never modify it in place. The sealed v1/v2 worker rejects
`workflowSource: builtin` before any filesystem lookup; route reviewed file workflows instead. When the
container entry point is `/runner-server`, set
`WORKFLOW_CONTROL_HEALTH_URL=http://127.0.0.1:8081/health/ready` so the image health check follows
the runner listener.

Only one runner-server may own a workspace. A dedicated PostgreSQL advisory lock enforces this for
the process lifetime. Each boot derives a new supervisor identity, allowing startup recovery to
distinguish old attempts. Readiness requires database access and a clean supported schema version.
The ordinary runner accepts the reviewed range from 2 through the current schema; optional shadow
profiles may narrow it. The default-off GS9-F1 v2 qualification profile requires at least schema 7
and accepts later reviewed current versions. Schema 7 adds typed v2 dispatch and event tables but
does not activate production v2 routing.

The default-off GS9-F2b profile is `workflow-control-runner-v2-runtime-delivery-v1` and requires
exactly schema 8. The host, not the bundle manifest, owns the runtime-delivery enable flag,
loopback companion origin, raw bearer plus its SHA-256 binding, owner-local journal root, and the
loopback E2 budget origin/token/caller binding. All child environment names are reserved and are
injected only into a selected v2 runtime-delivery worker; the v1 worker and F1-only v2 profile strip
them. Never place their values in the bundle, logs, evidence, or repository.

Operational handling is fail closed:

- `reconciliation_required`: stop automatic replay and inspect the runner reconciliation record;
- repeated pre-execution dispatch failure: observe the durable 250 ms exponential backoff; after
  five failures the record is dead/reconciliation-required and needs operator inspection;
- expired lease: verify current fence and process termination before allowing recovery;
- stale fence: terminate the old process and preserve the higher-fence attempt;
- process crash or forced termination: inspect whether JavaScript started and whether an effect
  boundary was open;
- bundle or descriptor hash drift: reject startup or the lease; do not overwrite the artifact.

The lease is an immutable hard deadline. Heartbeats do not renew it. The default is 60 seconds;
`WORKFLOW_RUNNER_CONTROL_LEASE_DURATION_MS` is an extension-only startup override bounded between
60 seconds and the frozen 24-hour protocol maximum. Lease expiry uses the existing bounded
cancellation and terminal-recording path. Changing it affects only leases claimed after that runner
process starts.

An unresolved v2 authority event is deliberately not clearable through cancellation in F1. Preserve
the job, inbox, receipt, and reconciliation evidence, stop automatic retries, and escalate it to the
GS9-F2 recovery procedure; do not delete rows or synthesize cancellation clearance. GS9-F2 must add
durable authority-event replay, cancellation coordination, and exact result disambiguation before
this state can be operationally released.

The silent-session cancellation probe currently polls every 250 ms, matching v1. Before enabling
long-lived v2 routing, GS9-F2 must measure per-session query rate, cancellation-latency distribution,
and database load, then compare bounded backoff and notification-based alternatives. The current
value is a qualification setting, not an unmeasured production SLO.

Under F2b, inspect the binding, resolution, event receipt, control-delivery ACK, and reconciliation
rows together. `awaiting_ack` means the exact control bytes may have reached the worker but their
durable ACK is absent; do not mark them delivered manually. A staged/resolved/runner-committed
binding surviving process loss is quarantined before scheduler recovery. Cancellation may occupy
the same binding's decision slot only when it preserves the frozen increasing sequence; otherwise
the attempt is reconciled rather than resequenced.

The metrics endpoint is authenticated and workspace-bound. When runner control is enabled, add it
as a separate Prometheus target and load the supplied runner alerts. Logs must use bounded IDs and
codes; never log the bearer token, descriptor content, workflow input, prompt, transcript, or
provider payload.

## Optional checkpoint observation

Checkpoint observation remains disabled unless the runner host is explicitly configured with the
closed `WORKFLOW_CONTROL_CHECKPOINT_SHADOW_*` settings. These names are reserved and cannot be
supplied by the sealed bundle manifest. The trusted runner host injects them into the child only
after accepting an advancing lease receipt; this is the only production composition path that can
mint the opaque attempt/lease/fence binding consumed by the TypeScript checkpoint store.

The child first persists artifact bytes and the TypeScript control head, then durably appends the
hash-only observation to `.openslack.local`. Remote delivery is asynchronous and fail-open. An
operator may inspect or explicitly flush the bounded local journal during qualification, but must
never copy its bearer, provider payload, workflow input, artifact bytes, prompts, results, or
absolute paths into evidence. A journal integrity error blocks only creation of false shadow
evidence; a Go transport outage cannot undo the authoritative TypeScript checkpoint.
