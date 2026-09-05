# GS9-D Qualification

This document records historical GS9-D post-commit effect-decision and audit parity,
when TypeScript was the sole effect decision and execution authority.

GS9-I retired the `workflow-control-effect-shadow-v1` entry profile. Run the current gate
with `bash scripts/go-check.sh services/workflow-control` and the checked-in
`workflow-control-runner-v2-runtime-delivery-v1` configuration. That gate retains the
applicable GS9-D parity checks alongside the current runner qualification; do not restore
the retired profile to perform a drain or rollback.

The historical evidence included:

- deterministic regeneration and exact checking of the D1 effect-control contract and D3 shadow
  envelope, receipt, head, outbox, schema, manifest, and golden-vector bundle;
- exact TypeScript `approval_created → approval_decided → audit_recorded` recovery from durable
  owner-local state and ordered append-before-send journal replay;
- observer default-off composition, exact loopback route and identity headers, bounded streaming,
  offline backlog, tamper, symlink/reparse, owner-only, response-loss, and restart behavior;
- PostgreSQL exact replay, fingerprint conflict, concurrent single winner, sequence gap, identity
  drift, mismatch latch, decision/audit outbox atomicity, stored integrity failure, unknown commit
  reconciliation, and process restart continuity;
- private authentication, lightweight readiness, closed metrics, status mapping, OpenAPI instance
  validation, migration inventory, isolated down migration, and schema-range checks;
- deterministic image build and proof that `/effect-shadow-server` remains observation-off without
  its explicit mode while the image default entry point remains `/server`.

Qualification must also prove the negative authority boundary: legacy run-gate approval,
callbacks, manifest metadata, unattended mode, effect intent, execution claim, outbox entries, and
Go receipts never authorize or execute an effect. Raw prompt, provider request/response, effect
detail or result, human nonce or reason, credentials, endpoints, transcripts, stacks, and absolute
paths are prohibited from evidence.

Passing this gate establishes only `GS9-D LOCAL_PASS / Go effect authority NOT_CLAIMED`. It does
not establish authenticated external host qualification, runner-v2 delivery, production routing,
canary, release, or TypeScript writer retirement.
