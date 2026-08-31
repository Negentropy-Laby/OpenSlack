# GS8-B Qualification

Repository qualification has four independent layers:

1. TypeScript contract/session/descriptor/worker tests, including native Windows ACL and junction
   rejection.
2. Go store, scheduler, process supervisor, HTTP and OpenAPI tests, including stale fencing,
   response loss and durable reconciliation.
3. Real PostgreSQL tests and a two-process seed/verify harness with a PostgreSQL restart.
4. A hosted cross-language harness that produces byte-identical bundles from two checkout roots,
   stages the self-contained `workflow-runner-worker.cjs` beside a copied Node executable and exact
   manifest, and starts it below a `type: module` ancestor. The `.cjs` suffix fixes parsing at the
   file itself. The harness also proves completion/cancellation
   receipts, persists an unproven-termination reconciliation through the real PostgreSQL store,
   and injects an unknown effect-outcome commit.

Runner protocol fixtures with action-time bindings construct the envelope and payload from one
canonical timestamp and validate the complete record input before exercising store transitions.
The reviewed Go verifier additionally runs the persisted-cancel and late-terminal `cancel_ack`
tests 100 times under the pinned Go/PostgreSQL qualification environment. Repetition is a
backstop for timing instability; deterministic fixture construction remains the correctness gate.

The default image smoke additionally proves `mode=shadow-only` and a `404` runner route. Native
Windows CI builds and starts the same real `.cjs` artifact before exercising the Job Object process
tree and descriptor ACL/reparse boundary. Sealed v1/v2 qualification rejects builtin submissions
before path resolution; ordinary TypeScript builtin discovery is outside this sealed boundary. The reviewed
Go verifier repeats PostgreSQL runner-store, restart, Prometheus, distribution and default-off
image gates.

Passing these gates is `LOCAL_PASS` for the default-off lifecycle path. It is not evidence of GS9
Workflow Control authority, authenticated Qoder Desktop, remote Connector, external effects,
release, live deployment, production readiness, review closure, or independent human approval.
