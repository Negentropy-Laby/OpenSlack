# OpenSlack × Negentropy-Lab Integration

This document describes the planned relationship between OpenSlack and
Negentropy-Lab. It is a design-target integration, not a currently active
mounted capability. OpenSlack remains a standalone workflow-first agent
collaboration workbench for GitHub-native human-agent teams.

## Product Position: Workbench vs. Control Plane

OpenSlack is a **workflow-first agent collaboration workbench**. Its source of
truth is GitHub Issues, Pull Requests, Git branches, and the local `.openslack`
workspace. The product's core loop is:

```
Issue → Agent → PR → Doctor → Human Approval → Merge Steward → Done
```

Negentropy-Lab is a **control-plane and state-governance hub** built around the
OpenDoge triple-layer architecture. Its truth triad is `AuthorityState`,
`EventStore`, and `Projection`. Negentropy-Lab owns authority state and policy
truth.

OpenSlack does not become a Negentropy-Lab runtime, and Negentropy-Lab does not
replace OpenSlack's GitHub workbench. The planned integration is an **external
slot contribution** from OpenSlack into Negentropy-Lab's slot platform. The
contribution is read-only evidence and projection data that Negentropy-Lab may
absorb; all authority-side mutations remain Negentropy-Lab's responsibility.

## Current Status

- **Standalone workbench:** OpenSlack's full GitHub Issues task loop, PRMS
  doctor, human-approval gates, and Collaboration Layer are active today.
- **Negentropy-Lab slot surface:** Planned. No `openslack integration negentropy
  ...` commands are implemented in this release; they are referenced as
  **Planned** in the companion documents below.

## Target Slot Facts

The intended Negentropy-Lab surface is the `scenario-pack.extension` slot:

| Property | Value |
|----------|-------|
| `slotId` | `scenario-pack.extension` |
| `kind` | `scenario-pack` |
| `layer` | `L5` (Scenario / Workflow / Representative Modules) |
| `sealed` | `false` |
| `allowExternal` | `true` |
| `defaultGateMode` | `SHADOW` (on the slot definition) |

An external OpenSlack contribution would set `providerKind: external` and
`gate.mode: SHADOW`. The `scenario-pack` layer is explicitly non-mutating: it
must not mutate `AuthorityState` directly.

The slot definition forbids these API methods for scenario-pack contributions:

- `authorityWriterHandle`
- `proposeMutation`

OpenSlack will never receive a writer handle or call mutation routes.

Slot contributions follow a nine-state lifecycle:

`discovered → registered → validated → installed → activated → degraded →
disabled → deprecated → removed`

The real slot catalog routes are split across two families:

- `/api/authority/slots`
- `/api/authority/slot-contributions`

Specifically:

```text
GET    /api/authority/slots
GET    /api/authority/slots/definitions
GET    /api/authority/slots/:slotId
GET    /api/authority/slot-contributions
GET    /api/authority/slot-contributions/:contributionId/diagnostics
POST   /api/authority/slot-contributions
POST   /api/authority/slot-contributions/:contributionId/activate
POST   /api/authority/slot-contributions/:contributionId/deactivate
```

OpenSlack would be inspected through the `GET` routes and governed through the
`POST` routes during activation. There is no separate integrations route family;
the slot catalog and contribution routes above are the real surface.

## Integration Modes

### 1. Sidecar Evidence

OpenSlack exports structured evidence from its workbench operations:

- Dynamic workflow run JSON and progress summaries
- PRMS `doctor` and `status` reports
- Profile Sync projection payloads
- Collaboration event JSONL summaries

This evidence is read-only audit material. Negentropy-Lab can ingest it as
`EventStore` input without treating OpenSlack as an authority writer.

### 2. Scenario-Pack Slot Contribution

OpenSlack would contribute to the `scenario-pack.extension` slot as an
`external` provider. The contribution remains in `SHADOW` mode by default, so
Negentropy-Lab operators can observe exported scenarios and workflow patterns
before any enforcement or promotion.

### 3. Projection Route

Negentropy-Lab may absorb OpenSlack projections such as activity feeds,
digests, room views, handoffs, and decision records as read-only views. These
projections are derived from GitHub and `.openslack` source-of-truth objects; if
OpenSlack disappeared, the same state could be reconstructed from GitHub +
Git + `.openslack` + the audit log.

### 4. Governed Action Request

When OpenSlack needs to request an authority-side state change in
Negentropy-Lab, it does so as a **governed action request** that flows through
Negentropy-Lab's own approval and policy gates. The request is evidence, not a
writer mutation. Human approval for these requests follows the same rules
described in `docs/security/human-approval.md`.

## What OpenSlack Contributes

| Contribution | What OpenSlack exports |
|--------------|------------------------|
| GitHub Issues / PR monitoring | Real-time status of claims, tasks, PRs, and review threads |
| PRMS readiness | `openslack pr doctor` and `openslack pr status` outputs |
| Dynamic workflow run summaries | Typed workflow run JSON, progress, and event correlation IDs |
| Profile Sync projections | Whitepaper-derived profile README updates and sync events |
| Agent conversation evidence | Redacted handoffs, decisions, and room summaries linked to GitHub objects |

All of these are projections or evidence. None of them require OpenSlack to hold
authority state.

## What OpenSlack Must Not Own

OpenSlack must never own or directly mutate the following:

- **`AuthorityState`** — Negentropy-Lab is the sole authority owner.
- **Direct mutation routes** — OpenSlack cannot call routes that change
  Negentropy-Lab authority state.
- **Writer handles** — `authorityWriterHandle` is forbidden for the target slot.
- **`proposeMutation`** — scenario-pack slots must not propose authority
  mutations.
- **Product policy truth** — Policy, risk zones, and governance decisions remain
  in Negentropy-Lab's control plane.
- **MCP transport internals** — OpenSlack remains a GitHub-agent workbench; it
  does not own or implement Negentropy-Lab's transport or runtime internals.

## Related Documentation

- `docs/product/profile-sync.md` — how Profile Sync produces a projection that
  Negentropy-Lab may absorb as audit evidence.
- `docs/developer/negentropy-slot-adapter.md` — the planned adapter manifest,
  evidence export contract, and slot lifecycle mapping for developers.
- `docs/security/human-approval.md` — approval rules that also apply to
  governed action requests from OpenSlack into Negentropy-Lab.
- `docs/product/collaboration-layer.md` — projection-only design of the
  Collaboration Layer, which is the source of OpenSlack's exported evidence.
