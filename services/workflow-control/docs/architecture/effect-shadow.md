# GS9-D Effect Decision and Audit Shadow Boundary

GS9-D observes TypeScript-owned effect approval and audit transitions after their owner-local
commit. It does not transfer decision or effect-execution authority to Go.

## Authorities

- TypeScript remains the sole writer of effect intent, approval, human-decision binding,
  execution claim, effect outcome, audit projection, and user-visible Workflow state.
- The GS8 runner store remains the owner of job, attempt, lease, fencing, and exact v1 effect
  intent receipts. Runner v1 is unchanged.
- The GS9-B authority and GS9-C checkpoint namespaces remain isolated.
- Go owns only `workflow_control_effect_shadow_*` observation, matched-prefix, exact receipt,
  read-only outbox, and reconciliation evidence.

Legacy run-gate records are `run_gate_only`. An approved legacy gate, callback, manifest entry,
or unattended flag never produces an effect execution grant and is never sent to this observer.

## Commit and delivery order

The authoritative TypeScript order is:

```text
accepted GS8 effect-intent receipt
→ owner-local v2 approval state durable
→ owner-local decision or audit transition durable
→ owner-only observation journal durable
→ asynchronous Go delivery
```

The observer operations are exactly `approval_created`, `approval_decided`, and
`audit_recorded`. Effect intent, execution claim, stored replay result, legacy run gate, raw effect
detail, human attestation nonce, raw reason, provider data, credentials, bearer, endpoint,
transcript, stack, and local path are excluded from the wire. The decision projection carries only
bounded identities, timestamps, status and SHA-256 digests.

Go failure is fail-open to the already committed TypeScript transition. The owner-only journal
supports ordered replay and bounded diagnostics without making remote delivery part of the effect
decision or execution path. Transient transport failures receive a bounded eight-attempt
exponential retry; the durable entry remains available for explicit replay or process-restart
recovery after that bound.

## Go differential behavior

Each approval lifecycle has source sequences one through three, exactly equal to approval revision
plus one. Go validates canonical bytes and exact workspace/caller/build identity, recomputes the
three-step projection, and returns a byte-stable receipt. Same idempotency key and fingerprint
replay the original accepted receipt with an HTTP replay header; a different fingerprint is a
conflict.

A semantic mismatch is durable evidence and permanently latches the matched projection. It may
advance the observed sequence but cannot advance the matched prefix or create an outbox row. Only
matched decision and audit observations atomically create sanitized pending outbox entries named
`effect_decision_observed` and `effect_audit_recorded`. The outbox has no publish,
acknowledgement, mutation, grant, or effect endpoint. Its read route uses an opaque, exact
PostgreSQL-timestamp keyset cursor so every immutable row remains traversable beyond the 100-item
page ceiling without duplicate or omitted rows.

An ambiguous commit first performs exact receipt point-read and otherwise persists
`reconciliation_required`. Go unavailability, mismatch, outbox state, or reconciliation never
approves, rejects, executes, resumes, retries, or rolls back a TypeScript effect. Corrupt stored
evidence returns an integrity error rather than a retryable database error.

The `effect-shadow-server` binary is health-only by default and exposes data routes only under
exact loopback `local-qualification-v1` configuration. The evidence ceiling is
`GS9-D LOCAL_PASS / Go effect authority NOT_CLAIMED`; runner-v2 delivery, routing, canary,
production, release, and TypeScript writer retirement remain later batches.
