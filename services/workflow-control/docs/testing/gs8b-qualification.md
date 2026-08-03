# GS8-B Qualification

Repository qualification has four independent layers:

1. TypeScript contract/session/descriptor/worker tests, including native Windows ACL and junction
   rejection.
2. Go store, scheduler, process supervisor, HTTP and OpenAPI tests, including stale fencing,
   response loss and durable reconciliation.
3. Real PostgreSQL tests and a two-process seed/verify harness with a PostgreSQL restart.
4. A hosted cross-language harness that bundles the worker into one self-contained
   `workflow-runner-worker.js`, seals it beside a copied Node executable and exact manifest,
   proves completion/cancellation receipts, and injects an unknown effect-outcome commit.

The default image smoke additionally proves `mode=shadow-only` and a `404` runner route. Native
Windows CI exercises the Job Object process tree and descriptor ACL/reparse boundary. The reviewed
Go verifier repeats PostgreSQL runner-store, restart, Prometheus, distribution and default-off
image gates.

Passing these gates is `LOCAL_PASS` for the default-off lifecycle path. It is not evidence of GS9
Workflow Control authority, authenticated Qoder Desktop, remote Connector, external effects,
release, live deployment, production readiness, review closure, or independent human approval.
