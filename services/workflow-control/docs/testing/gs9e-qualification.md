# GS9-E Qualification

GS9-E qualification proves the isolated durable Go budget authority without transferring the
production TypeScript writer.

The reviewed gate is `scripts/go-check.sh services/workflow-control` with runtime profile
`workflow-control-budget-authority-v1`. It is a strict superset of the GS7-B shadow, GS8-B runner,
GS9-B authority, GS9-C checkpoint-shadow, and GS9-D effect-shadow gates. The hosted PostgreSQL
profile is:

```bash
bash scripts/qualification/workflow-control-postgres-gate.sh gs9e-budget
```

Required evidence includes:

- exact TypeScript/Go E1 manifest, schema, golden-vector, canonical-byte, arithmetic, and fold
  parity;
- closed Go durable companion envelopes around unchanged, non-authorizing E1 projections, including
  manifest/build/kind/domain-hash binding and cross-splice rejection;
- schema 6 migration isolation, append-only evidence, and a down migration that refuses evidence;
- first-reserve account creation at account revision zero and lockstep run/account CAS thereafter;
- accepted and rejected reserve replay, fingerprint conflicts, semantic reservation/call/attempt
  uniqueness, byte-identical response-loss recovery, and exact replay before active build/policy
  drift checks;
- successful and failed provider usage settlement, provider-outcome reconciliation, and database
  commit-unknown reconciliation that atomically latches the run only after proving the original
  mutation absent and the request-bound run head unchanged;
- concurrent three-dimensional token, `nano_usd`, and call reservations that never overspend;
- account/run revision drift as a conflict distinct from immutable evidence drift, strict trailing
  JSON rejection, signed-int64 boundaries, half-up non-negative rounding, overflow rejection, and ledger rebuild
  from the immutable genesis account after PostgreSQL restart, covering every closed ledger kind
  and rejecting anchor, chain, fold, or provider-attempt/usage-receipt binding drift;
- cache-hit zero mutation and qualification ordering that makes reserve durable before provider
  execution and settlement durable before cache visibility;
- rejection of legacy run-gate approval as reservation authority;
- fail-closed rejection of any nonzero resume generation while Runner v2 remains undelivered;
- provider reconciliation leaving its reservation open, terminal settlement time binding, safe
  non-null accepted revisions, and the cross-authority database-reconciliation gate;
- private authentication, exact workspace/caller/route/build binding, lightweight readiness,
  closed metrics, stable HTTP errors, and closed OpenAPI validation;
- deterministic image construction and proof that `/budget-authority-server` is mutation-off
  without its explicit mode while the image default remains `/server`.

Credential values, prompts, provider request/response content, endpoints, transcripts, stack
traces, and absolute local paths are excluded from checked-in evidence.
The qualification profile supplies service/build identity, bearer digest, workspace, caller,
routing epoch, policy hash, and three canonical int64 limits from the closed, non-secret
`testdata/gs9e-qualification.conf` fixture. The seed is process composition, not an HTTP field.

Passing the gate establishes only:

```text
GS9-E LOCAL_PASS
Go durable budget qualification authority
Go production Workflow budget authority NOT_CLAIMED
Runner v2 NOT_DELIVERED
routing / canary / cutover NOT_ACTIVATED
WORKFLOW_BUDGET_PRODUCTION_INITIAL_POLICY_SOURCE NOT_DELIVERED
```

It does not establish authenticated external-host qualification, live verification, release,
production routing, a production budget client, Go Workflow authority, or TypeScript writer
retirement.
