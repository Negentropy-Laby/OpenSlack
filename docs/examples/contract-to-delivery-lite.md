---
schema: openslack.document.v1
id: example-contract-to-delivery-lite
status: In Review
authority: canonical
audience:
  - users
  - contributors
owner: collaboration
updated: 2026-07-29
sources:
  - scripts/contract-delivery-rehearsal/index.ts
  - scenarios/contract-to-delivery-lite/scenario.lock.json
  - design/cdd/workstreams/scenario-runtime/README.md
---

# Contract-to-Delivery Lite local rehearsal

The repository includes one credential-free, repeatable rehearsal of the reviewed
Contract-to-Delivery Lite Scenario and Workflow composition:

```bash
bun run demo:contract-delivery
```

The command creates an isolated temporary workspace, derives an agent principal from a matching
local registry and runtime identity, and drives the official MCP SDK over an in-memory transport.
It verifies the exact 16-tool `agent-bound` catalog and performs:

```text
preview locked Scenario
  -> confirm exact Scenario plan
  -> persist active Scenario instance
  -> preview reviewed contract.delivery.lite Workflow
  -> confirm exact Workflow plan
  -> append bounded Collaboration evidence
  -> persist completed Scenario instance
  -> assemble a typed fixture-backed source snapshot
  -> explicitly publish the graph snapshot
  -> query and explain it through the read-only MCP tools
```

The graph read tools never build or publish a snapshot. Publication remains an explicit,
compare-and-swap operation after the governed Workflow evidence has been durably read back.

## Evidence boundary

| Evidence                                      | Origin                     | Claim                                     |
| --------------------------------------------- | -------------------------- | ----------------------------------------- |
| principal, plans, Scenario and Workflow state | governed local stores      | real local governed execution             |
| `workflow.started` event                      | Collaboration local store  | real bounded local coordination evidence  |
| graph build, query, and explain               | explicit local graph store | real local projection and readback        |
| Customer-to-Outcome business chain            | `demo_fixture`             | deterministic demonstration data only     |
| GitHub delivery                               | `not_run`                  | no live issue, PR, review, or merge claim |
| Qoder Work Desktop                            | `not_run`                  | no `QODER_VERIFIED` claim                 |

Success prints a path-free
`openslack.contract_delivery_lite_local_rehearsal.v1` result with
`evidenceLevel: CONTRACT_TO_DELIVERY_LOCAL_REHEARSED`. That evidence level is intentionally
narrower than live scenario qualification, authenticated Qoder Desktop qualification, or
interview readiness.

The rehearsal has no GitHub writer, approval, merge, shell, credential, notification, or remote
adapter path. Its temporary workspace is removed after the result is produced.
