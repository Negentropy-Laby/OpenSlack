# GS9-C Qualification

GS9-C qualification proves post-commit checkpoint/resume differential behavior while TypeScript
remains the sole Workflow writer.

The reviewed gate is `scripts/go-check.sh services/workflow-control` with runtime profile
`workflow-control-checkpoint-shadow-v1`. It is a strict superset of the GS7-B shadow, GS8-B runner,
and GS9-B authority gates.

Required evidence includes:

- deterministic regeneration and exact checking of the checkpoint observation, envelope, control,
  artifact, receipt, and golden-vector bundle;
- `checkpoint_commit` only after phase work, contiguous phase order, exact duplicate replay, and
  independent source-sequence/revision bindings;
- explicit `resume_advance`, repeated valid resumes, stale attempt/lease/fence rejection, and
  workflow-source/manifest/input drift rejection;
- artifact missing/tamper and control/journal corruption failure;
- PostgreSQL concurrent single-winner behavior, fingerprint conflict, mismatch latch, exact stored
  receipt replay, response-loss point-read, unknown commit reconciliation, and restart continuity;
- private identity, readiness, metrics, HTTP status, OpenAPI, migration/down-migration, and stored
  integrity behavior;
- image qualification proving `/checkpoint-shadow-server` remains observation-off without its
  explicit mode while the default image entry point remains `/server`.

The TypeScript observer must prove local journal durability without waiting for an unavailable Go
service, bounded offline backlog behavior, owner-only/no-follow journal reads, and replay after
crash windows. Qualification artifacts contain only hashes, bounded identities, counts, stable
codes, and timestamps; secrets and raw workflow/provider/artifact content are prohibited.

Passing this gate establishes only `GS9-C LOCAL_PASS / Go authority NOT_CLAIMED`. It does not prove
authenticated external host qualification, production routing, runner-v2 delivery,
approval/effect authority, durable budget authority, canary, release, or TypeScript writer
retirement.
