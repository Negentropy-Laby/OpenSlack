# Negentropy-Lab Slot Adapter

This document is the developer guide for the planned OpenSlack contribution to
the Negentropy-Lab slot platform. OpenSlack remains a standalone GitHub-native
agent workbench; this adapter describes the **design-target** external slot
surface, not a currently mounted integration.

All `openslack integration negentropy ...` commands described here are
**Planned** and are not implemented yet. The real, current evidence sources are
the existing `openslack collaboration ...`, `openslack pr ...`, and
`openslack profile-sync ...` commands listed in each section.

For the product framing, see [`docs/product/negentropy-lab-integration.md`](../product/negentropy-lab-integration.md).
For the hard security rules, see [`docs/security/negentropy-slot-boundary.md`](../security/negentropy-slot-boundary.md).

---

## Target Slot

OpenSlack targets the `scenario-pack.extension` slot on the Negentropy-Lab
control plane. This slot lives at layer L5, which is reserved for scenario /
workflow / representative modules that do not mutate authority state directly.

| Field | Value | Source of truth |
|-------|-------|-----------------|
| `slotId` | `scenario-pack.extension` | `server/slots/definitions/scenario-pack-definitions.ts` |
| `kind` | `scenario-pack` | Slot definition |
| `layer` | `L5` | Layer taxonomy: Scenario / Workflow / Representative Modules |
| `sealed` | `false` | External contributions are allowed |
| `allowExternal` | `true` | OpenSlack contributes as an external provider |
| `providerKind` | `external` | Provider kinds: `built-in`, `bundled`, `workspace`, `external`, `plugin` |
| `defaultGateMode` (definition) | `SHADOW` | Field on `SlotDefinition` |
| `gate.mode` (contribution) | `SHADOW` | Field on `SlotManifest` / `SlotContribution` |

The `defaultGateMode: SHADOW` on the slot definition means newly contributed
scenario packs start in observation mode. A contribution must explicitly set
`gate.mode: SHADOW` in its manifest and request a promotion path if it later
needs `ENFORCE`.

---

## Contribution Manifest Sketch

The planned OpenSlack contribution is a `SlotContribution` with a `SlotManifest`
that satisfies the real Negentropy-Lab manifest fields. No writer handle is
included; the contribution is projection-only.

```typescript
interface SlotManifest {
  contributionId: "openslack-scenario-pack.v0",
  slotId: "scenario-pack.extension",
  name: "OpenSlack Scenario Pack",
  version: "0.1.0-rc",
  providerKind: "external",
  providerId: "Negentropy-Laby/OpenSlack",
  layer: "L5",
  kind: "scenario-pack",
  requiredPlatformCapabilities?: ["github-webhook", "event-store-read"],
  permission: {
    // No authority writer handle; forbidden by slot policy.
    forbiddenApiMethods: ["authorityWriterHandle", "proposeMutation"]
  },
  gate: {
    mode: "SHADOW" // "OFF" | "SHADOW" | "ENFORCE"
  },
  evidenceRefs?: [
    { kind: "workflow-run-json", path: "/evidence/runs/{runId}.json" },
    { kind: "prms-report", path: "/evidence/prms/{prNumber}.json" },
    { kind: "profile-sync-status", path: "/evidence/profile-sync/status.json" },
    { kind: "collaboration-events", path: "/evidence/events/summary.jsonl" }
  ],
  signature?: "<external-signature>",
  docPath?: "memory_bank/t1_axioms/integrations/openslack-scenario-pack.md",
  skuKey?: "openslack-external-scenario-pack",
  metadata?: {
    owner: "OpenSlack",
    sourceRepo: "Negentropy-Laby/OpenSlack",
    trustTier: "external-shadow"
  }
}

interface SlotContribution {
  manifest: SlotManifest,
  routes?: {
    // External read-only evidence routes. No mutation routes.
    evidenceBase: "/evidence/openslack"
  },
  realtimeRooms?: ["openslack:workflow-runs", "openslack:prms"],
  lifecycle?: {
    // Maps to SlotLifecycleState; see Activation Lifecycle below.
    autoPromote: false,
    promotionRequires: ["human-approval", "golden-eval-pass"]
  },
  metadata?: {
    description: "OpenSlack exports workflow, PRMS, profile-sync, and collaboration evidence to Negentropy-Lab as a read-only scenario-pack contribution."
  }
}
```

The `permission.forbiddenApiMethods` array is required by the
`scenario-pack.extension` slot policy and explicitly blocks the two methods
that could mutate authority state: `authorityWriterHandle` and
`proposeMutation`.

---

## Evidence Export Contract

The adapter exports four evidence bundles. These are the **planned adapter
schema**, not the current CLI output for every source. Some current sources
(`pr status`, `profile-sync status`) are text-oriented; the JSON shapes below are
the contract the adapter would produce when Negentropy-Lab consumes OpenSlack
evidence.

### 1. Workflow Run JSON

Real current source:

```bash
openslack collaboration workflow runs show <runId> --detail progress --format json
```

Planned adapter schema:

```json
{
  "evidenceKind": "workflow-run",
  "runId": "run-20260708-001",
  "workflowName": "golden-eval-suite",
  "startedAt": "2026-07-08T12:00:00Z",
  "status": "completed",
  "phases": [
    {
      "name": "classify",
      "status": "passed",
      "agent": "openslack-agent-operator[bot]",
      "transcriptRef": "openslack:transcript:run-20260708-001:phase-0"
    }
  ],
  "outputs": {
    "summary": "All golden evals passed.",
    "budget": { "tokens": 12000, "maxAgents": 3 }
  },
  "correlationId": "corr-openslack-20260708-001"
}
```

### 2. PRMS Report Payload

Real current sources:

```bash
openslack pr status <n>
openslack pr doctor <n>
```

Planned adapter schema (JSON projection of the text report):

```json
{
  "evidenceKind": "prms-report",
  "prNumber": 42,
  "headSha": "abc123",
  "reviewDecision": "REVIEW_REQUIRED",
  "mergeStateStatus": "BLOCKED",
  "gates": [
    { "gate": "human-approval", "state": "missing" },
    { "gate": "checks", "state": "pass" },
    { "gate": "review-threads", "state": "pass" }
  ],
  "riskZone": "green",
  "recommendation": "READY_TO_MERGE_AFTER_APPROVAL",
  "exportedAt": "2026-07-08T12:05:00Z"
}
```

### 3. Profile-Sync Status Payload

Real current source:

```bash
openslack collaboration workflow profile-sync status
```

Planned adapter schema (JSON projection of the text status):

```json
{
  "evidenceKind": "profile-sync-status",
  "sourceRepo": "Negentropy-Laby/whitepapers",
  "sourcePath": "posts",
  "targetRepo": "Negentropy-Laby/.github",
  "targetPath": "profile/README.md",
  "markers": ["latest-insights"],
  "lastSyncAt": "2026-07-08T06:00:00Z",
  "state": "synced",
  "pendingPrUrl": null,
  "projectionNote": "The rendered profile README is a projection of the whitepapers source; Negentropy-Lab may absorb this event as audit evidence."
}
```

### 4. Collaboration Event JSONL Summary

Real current source: `openslack collaboration activity` and `openslack collaboration digest` produce projection-only views; the adapter would export the underlying JSONL event store as a summary.

```jsonl
{"eventType": "handoff.created", "id": "handoff-1", "roomId": "pr:42", "timestamp": "2026-07-08T11:00:00Z", "agent": "openslack-agent-operator[bot]"}
{"eventType": "decision.recorded", "id": "decision-1", "roomId": "pr:42", "timestamp": "2026-07-08T11:05:00Z", "decision": "proceed-after-review"}
{"eventType": "workflow.run.completed", "runId": "run-20260708-001", "timestamp": "2026-07-08T12:00:00Z"}
```

---

## Activation Lifecycle

A Negentropy-Lab slot contribution moves through nine `SlotLifecycleState`
values. The OpenSlack adapter maps each state to an operational condition.

| State | Meaning for OpenSlack adapter | Trigger / Gate |
|-------|-------------------------------|----------------|
| `discovered` | OpenSlack repo declares intent to contribute to `scenario-pack.extension` | Source doc published (`docs/developer/negentropy-slot-adapter.md`) |
| `registered` | Contribution manifest is POSTed to `/api/authority/slot-contributions` | Requires bot-authenticated PR and human approval if policy requires it |
| `validated` | Negentropy-Lab validates manifest schema, forbidden methods, and signature | Manifest passes `SlotRegistry` validation rules |
| `installed` | Evidence routes are wired and OpenSlack is authorized to push evidence | Bot credential + route handshake complete |
| `activated` | Contribution is live in `SHADOW` mode; evidence flows, no enforcement | `gate.mode: SHADOW` and all health checks green |
| `degraded` | Evidence export is stale, GitHub credentials are missing, or `status verify` failed | See Diagnostics / Degraded Triggers below |
| `disabled` | Operator or governance disables the contribution | Manual governance action or policy violation |
| `deprecated` | A newer contribution supersedes this one | New version registered and promoted |
| `removed` | Contribution is withdrawn and evidence routes are torn down | Explicit removal or retirement |

OpenSlack never moves itself to `activated`. Promotion from `installed` to
`activated` (and later from `SHADOW` to `ENFORCE`) is a Negentropy-Lab control-plane
decision that requires external authorization.

---

## Diagnostics and Degraded Triggers

The adapter exposes diagnostics at the planned Negentropy-Lab endpoint:

```text
GET /api/authority/slot-contributions/:contributionId/diagnostics
```

OpenSlack would populate the diagnostics payload from the following local health
signals.

| Trigger | Diagnostic state | Recovery action |
|---------|------------------|-----------------|
| GitHub App credentials missing or expired | `degraded` | Re-run bot credential setup; `openslack doctor` (real) |
| `openslack status verify` failed | `degraded` | Regenerate `docs/status/current.md` from `.openslack/modules.yaml` (real) |
| Evidence export timestamp older than threshold | `degraded` | Re-run the evidence source command or scheduled export |
| PRMS unavailable or `pr doctor` returns non-READY | `degraded` | Resolve PRMS gates and re-export report |
| Slot contribution manifest invalid | `disabled` | Fix manifest and re-register |
| Forbidden API method called | `removed` | Governance review; adapter must be fixed |

Planned diagnostic commands for operators:

| Command | Status | Purpose |
|---------|--------|---------|
| `openslack integration negentropy export-slot` | **Planned** | Build and emit the `SlotContribution` manifest for registration |
| `openslack integration negentropy doctor` | **Planned** | Run local health checks and report diagnostic state |
| `openslack integration negentropy status` | **Planned** | Show the contribution's lifecycle state and last evidence export timestamp |

---

## Boundary Summary

- OpenSlack does **not** own `AuthorityState`.
- OpenSlack receives **no** writer handle.
- OpenSlack **never** calls `proposeMutation` or `authorityWriterHandle`.
- All GitHub-side mutations remain ordinary GitHub Issue / PR mutations.
- Negentropy-Lab absorbs OpenSlack output only as evidence, projection, or a
  governed action request.
- The contribution starts and remains in `SHADOW` until an explicit promotion path
  is approved.

These rules are expanded in [`docs/security/negentropy-slot-boundary.md`](../security/negentropy-slot-boundary.md).
