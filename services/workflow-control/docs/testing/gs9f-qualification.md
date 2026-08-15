# GS9-F1 Foundation Qualification

GS9-F1 qualifies only the frozen Workflow Runner v2 admission/storage, negotiation, and
receipt-before-decision transport foundation plus a local opaque-call ordering seam. It
does not deliver the real checkpoint, TypeScript effect, budget, or resume adapters and does not
activate production v2 submission or routing.

The reviewed local gate is:

```bash
bash scripts/go-check.sh services/workflow-control
```

The service config must select
`workflow-control-runner-v2-foundation-v1`. Its mechanical repository gate is a strict superset of
GS7-B, GS8-B, and GS9-B/C/D/E and runs:

- frozen runner-v1 and authority-v2 parity checks without modifying their source bytes;
- exact ordered `[v1, v2]` negotiation, v2 selection, old-worker and capability rejection, and no
  downgrade;
- job/attempt/lease/fence plus route/build/epoch/run-revision/resume-generation foundation binding
  checks;
- event and exact receipt persistence plus receipt delivery before the later domain-decision
  boundary is exposed;
- exact replay, conflict, stale fencing, response loss, and PostgreSQL restart for the foundation
  records;
- local reserve-before-fetch and settle-after-receipt ordering around an opaque provider call,
  without propagating or binding provider/model/run identity into E authority;
- PostgreSQL restart using one retained qualification schema; and
- built-image evidence that the default `/server` process does not submit or route v2 work.

The hosted exact-head workflow runs this service gate after the GS9-E budget gate and before the
workspace-wide `go-check --all` gate. Windows additionally rebuilds the sealed worker and runs the
native descriptor, reparse-point, process-tree, worker, and session boundaries.

Passing these gates establishes at most:

```text
GS9-F1 FOUNDATION LOCAL_PASS
runner v2 admission/storage/negotiation transport foundation
runner v2 runtime delivery NOT_CLAIMED
checkpoint/effect/budget/resume adapters NOT_DELIVERED
production v2 submission NOT_ACTIVATED
production v2 routing / canary / cutover NOT_ACTIVATED
TypeScript production Workflow authority retained
```

It does not establish complete receipt-to-checkpoint/effect/budget/resume decision ordering,
crash-after-authority recovery, or Go production Workflow, checkpoint, effect, budget-policy,
provider, RunStore, or user-visible read authority. GS9-F2 must deliver those runtime adapters and
their exit gates. Authenticated external-host, Qoder, remote Connector, live, release, tag, npm, and
production readiness also remain outside this evidence.
