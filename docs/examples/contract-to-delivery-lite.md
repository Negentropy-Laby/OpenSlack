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

## Reset

No existing workspace state is reused. Every invocation creates a fresh temporary OpenSlack
workspace, copies only the two locked Scenario Packs into it, derives a new runtime identity, and
starts with an empty governed-plan, Scenario-instance, Collaboration, and graph store.

```bash
bun run demo:contract-delivery
```

Running the command again is the reset procedure. It creates another isolated workspace rather
than mutating or attempting to repair the previous run.

## Input

The production rehearsal accepts no caller-supplied path, credential, principal, authority,
command, URL, or arbitrary Workflow input. It uses exactly:

```json
{
  "scenarioId": "contract-to-delivery-lite",
  "mode": "local_rehearsal",
  "fixtureId": "contract-to-delivery-lite-example",
  "workflowId": "contract.delivery.lite"
}
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

## Expected MCP tool calls

The command first asserts the exact 16-tool catalog. Its state-changing MCP sequence is:

1. `openslack_preview_scenario`
2. `openslack_confirm_plan`
3. `openslack_preview_workflow`
4. `openslack_confirm_plan`

After the host explicitly publishes the composite snapshot through the sealed graph builder, the
readback sequence is:

5. `openslack_query_graph`
6. `openslack_explain_graph`

There is no MCP graph-build tool and neither read tool can create or replace a snapshot.

## Evidence boundary

| Evidence                                      | Origin / status            | Claim                                     |
| --------------------------------------------- | -------------------------- | ----------------------------------------- |
| principal, plans, Scenario and Workflow state | governed local stores      | real local governed execution             |
| `workflow.started` event                      | Collaboration local store  | real bounded local coordination evidence  |
| graph build, query, and explain               | explicit local graph store | real local projection and readback        |
| Customer-to-Outcome business chain            | `demo_fixture`             | deterministic demonstration data only     |
| notification intent                           | `not_created`              | no notification intent is claimed         |
| notification delivery                         | `blocked_not_configured`   | no admitted live delivery path exists     |
| GitHub delivery                               | `not_run`                  | no live issue, PR, review, or merge claim |
| live capstone                                 | `LIVE_CAPSTONE_PENDING`    | separate from the local rehearsal result  |
| Qoder Work Desktop                            | `not_run`                  | no `QODER_VERIFIED` claim                 |

Success prints a path-free
`openslack.contract_delivery_lite_local_rehearsal.v1` result with
`evidenceLevel: CONTRACT_TO_DELIVERY_LOCAL_REHEARSED`. That evidence level is intentionally
narrower than live scenario qualification, authenticated Qoder Desktop qualification, or
interview readiness.

## Blocked cases

The run fails closed and prints a path-free `status: blocked` result when any required binding is
missing or changes, including:

- the registry/runtime principal, current permission, workspace assertion, or sealed catalog;
- the exact Scenario Pack lock, Scenario instance, Workflow resolver, executor, or plan;
- a reused or stale confirmation token, a store CAS conflict, or an existing graph cursor;
- any attempt to select an unregistered Workflow or fixture;
- any attempt to treat fixture evidence as live GitHub, notification, Qoder, approval, or merge
  evidence.

No blocked case degrades to the 12-tool profile, synthesizes authority, or publishes a partial
snapshot.

## Cleanup

The rehearsal has no GitHub writer, approval, merge, shell, credential, notification, or remote
adapter path. Its temporary workspace is removed in a `finally` path after either completion or a
blocked result. The repository working tree and user-level OpenSlack state are not modified.
