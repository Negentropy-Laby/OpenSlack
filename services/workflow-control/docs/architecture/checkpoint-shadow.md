# GS9-C Checkpoint and Resume Shadow Boundary

GS9-C observes TypeScript-owned checkpoint and resume transitions after their local commit. It
does not transfer Workflow authority.

## Authorities

- TypeScript `RunStore` is the only writer of the checkpoint control head, resume generation,
  source sequence, artifact bytes, and user-visible run state.
- The GS8 runner store remains the only owner of job, attempt, lease, and fencing records.
- The GS9-B authority spine remains isolated and does not receive checkpoint columns.
- Go owns only its `workflow_control_checkpoint_shadow_*` observation, projection, receipt, and
  reconciliation records.

The legacy synchronous `ctx.phase(name)` marks phase entry and preserves existing behavior. It is
not a durable phase commit. A workflow records an `after_phase_work` commit only by awaiting
`ctx.checkpoint.commit(...)` after the phase work has completed.

## Commit order

The authoritative local order is:

```text
bounded artifact durable
→ canonical TypeScript checkpoint control head durable
→ owner-only observation journal durable
→ asynchronous Go delivery
```

Artifact bytes remain local. The observation carries only bounded IDs, indices, timestamps,
runner binding fields, and SHA-256 digests. It excludes workflow input, prompts, provider
request/response bodies, cache values, artifact/result bytes, approval details, credentials,
bearers, endpoints, logs, transcripts, stacks, and absolute paths.

`resume_advance` is an explicit observation distinct from `checkpoint_commit`. It advances the
TypeScript revision and resume generation exactly once for a new accepted runner binding. The
binding is created only after an advancing GS8 `lease_accept` receipt. Reused attempt/lease/fence,
stale fencing tokens, identity drift, gaps, or non-contiguous phase commits fail closed in the
TypeScript control store before execution can claim new checkpoint evidence.

## Go differential behavior

The Go service consumes an independent per-run source sequence beginning at one. It validates
canonical bytes and exact workspace/caller/build identity, recomputes the expected projection, and
returns a byte-stable receipt. Same idempotency key and fingerprint replay the original accepted
receipt; the replay marker is an HTTP header, not a changed body. A different fingerprint is a
conflict.

A parity mismatch is accepted evidence but permanently latches the matched projection: the
observed source sequence advances while the last matched head does not. An ambiguous commit first
performs exact receipt point-read and otherwise persists `reconciliation_required`. Go
unavailability, mismatch, or reconciliation never blocks or authorizes TypeScript commit/resume.
Corrupt Go stored evidence returns an integrity error rather than a retryable database error.

The binary is health-only by default and exposes data routes only under exact loopback
`local-qualification-v1` configuration. The evidence ceiling is `GS9-C LOCAL_PASS / Go authority
NOT_CLAIMED`; runner-v2 delivery, approval/effect and budget authority, routing, canary, rollback,
old-record migration, and TypeScript writer retirement remain later batches.
