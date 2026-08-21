# GS9-F1 Foundation and GS9-F2a Contract Qualification

GS9-F1 qualifies only the frozen Workflow Runner v2 admission/storage, negotiation, and
receipt-before-decision transport foundation plus a local opaque-call ordering seam. It
does not deliver the real checkpoint, TypeScript effect, budget, or resume adapters and does not
activate production v2 submission or routing.

GS9-F2a is the contract-only first half of the GS9-F2 umbrella. Its generated
[authority-binding manifest](../../../../packages/workflows/contracts/workflow-runner-authority-binding/v1/manifest.json)
is the normative source for contract identity, operation facts, source locks, framing, and the
complete authority ceiling.

The reviewed local gate is:

```bash
bash scripts/go-check.sh services/workflow-control
```

The focused F2a local contract gates are:

```bash
bun run workflow:contract-families -- --check
bunx vitest run packages/workflows/src/__tests__/workflow-runner-authority-binding-contract.test.ts
(cd services/workflow-control && go test -race ./runnerbindingcontract -count=1)
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

The hosted exact-head workflow runs the service exactly once through the workspace-wide
`go-check --all` verifier after the GS9-E budget gate. Windows additionally rebuilds the sealed
worker and runs the native descriptor, reparse-point, process-tree, worker, and session boundaries.

Because F2a changes a Red-zone workflow, hosted exact-head CI runs the registry-driven Workflow
contract-family check once, includes the binding TypeScript suite in the reviewed
`workflow-runner*.test.ts` set, and includes the Go mirror in `go-check.sh --all`. The registry,
generated shell inventory, and generated Workflow Control `.dockerignore` marker are checked as one
closed inventory; no dedicated GS9-F2a step may drift from that inventory.

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

Passing the F2a gates establishes exact TypeScript/Go contract parity only. The manifest's
`notDelivered`, `notActivated`, `notClaimed`, and `separateGates` arrays are the complete,
machine-checked ceiling; qualification prose must not maintain a second negative-claim list.
GS9-F2b must deliver recovery/replay, result disambiguation, runtime adapters, and its measured
cancellation gate before any of those entries can change.
