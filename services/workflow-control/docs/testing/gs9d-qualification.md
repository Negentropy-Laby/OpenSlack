# GS9-D Qualification

GS9-D qualification proves post-commit effect-decision and audit parity while TypeScript remains
the sole effect decision and execution authority.

The reviewed gate is `scripts/go-check.sh services/workflow-control` with runtime profile
`workflow-control-effect-shadow-v1`. It is a strict superset of the GS7-B shadow, GS8-B runner,
GS9-B authority, and GS9-C checkpoint-shadow gates.

Required evidence includes:

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
