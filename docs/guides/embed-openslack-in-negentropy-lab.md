# Embed OpenSlack into Negentropy-Lab

> Mount OpenSlack as an **external** `scenario-pack.extension` slot contribution so Negentropy-Lab can absorb OpenSlack evidence and projections. OpenSlack remains a standalone workflow-first agent collaboration workbench and **never owns Negentropy-Lab `AuthorityState`**.

**Status:** planned / design-target. The `openslack integration negentropy ...` commands listed below are **not implemented yet**.

## Prerequisites

- OpenSlack repo installed and the `openslack` CLI available (`bun run openslack ...` or a global install).
- A running Negentropy-Lab control plane reachable at `$NEGENTROPY_LAB` with a token that can read `/api/authority/slots` and `/api/authority/slot-contributions`.
- The `scenario-pack.extension` slot definition exists in Negentropy-Lab with `layer: L5`, `allowExternal: true`, `defaultGateMode: SHADOW`, and `sealed: false`.
- GitHub App credentials for OpenSlack are configured so PRMS, workflow run, and profile-sync evidence can be exported.
- You accept that OpenSlack contributes with `providerKind: external`, `gate.mode: SHADOW`, and `permission.forbiddenApiMethods` including `authorityWriterHandle` and `proposeMutation`.

## What this produces

A `SlotContribution` whose manifest contains:

- `slotId: scenario-pack.extension`
- `kind: scenario-pack`
- `layer: L5`
- `providerKind: external`
- `gate.mode: SHADOW`
- `permission.forbiddenApiMethods: ["authorityWriterHandle", "proposeMutation"]`

OpenSlack exports the following evidence types:

- Workflow run JSON
- PRMS report payloads
- Profile-sync status payload
- Collaboration event JSONL summary

OpenSlack does **not** receive a writer handle, call `proposeMutation` directly, or store Negentropy-Lab authority state.

## Step 1: Export the OpenSlack slot contribution

```bash
# Planned — not implemented yet
openslack integration negentropy export-slot \
  --slot scenario-pack.extension \
  --provider-kind external \
  --gate-mode SHADOW \
  --out ./.openslack.local/negentropy-slot-contribution.json
```

This writes a `SlotContribution` manifest that Negentropy-Lab can register as an external contribution.

## Step 2: Diagnose the exported contribution before registration

```bash
# Planned — not implemented yet
openslack integration negentropy doctor \
  --contribution ./.openslack.local/negentropy-slot-contribution.json \
  --slot scenario-pack.extension
```

The planned doctor command checks:

- The manifest matches the slot definition (`layer: L5`, `kind: scenario-pack`, `allowExternal: true`).
- `permission.forbiddenApiMethods` includes `authorityWriterHandle` and `proposeMutation`.
- OpenSlack local health (`openslack doctor`) passes.
- GitHub credentials are present for evidence export.
- No writer handle or authority mutation route is requested.

## Step 3: Check OpenSlack integration status

```bash
# Planned — not implemented yet
openslack integration negentropy status \
  --slot scenario-pack.extension
```

The planned status command reports the contribution lifecycle state (`discovered`, `registered`, `validated`, `installed`, `activated`, `degraded`, etc.) and whether OpenSlack evidence is current.

## Step 4: Register the contribution with Negentropy-Lab

The OpenSlack CLI does not push to Negentropy-Lab directly. Submit the manifest from Step 1 to the Negentropy-Lab slot catalog:

```bash
curl -X POST "$NEGENTROPY_LAB/api/authority/slot-contributions" \
  -H "Authorization: Bearer $NEGENTROPY_LAB_TOKEN" \
  -H "Content-Type: application/json" \
  -d @.openslack.local/negentropy-slot-contribution.json
```

After registration, the contribution should move through the Negentropy-Lab `SlotLifecycleState` machine: `discovered → registered → validated → installed → activated`.

## Step 5: Verify in the Negentropy-Lab slot catalog

Query the real slot catalog routes to confirm the contribution is registered and healthy.

```bash
SLOT_ID="scenario-pack.extension"
CONTRIBUTION_ID="<contributionId from the Step 4 response>"

# Slot definition
curl -s "$NEGENTROPY_LAB/api/authority/slots/$SLOT_ID" | jq .

# Registered contributions
curl -s "$NEGENTROPY_LAB/api/authority/slot-contributions" | jq .

# Contribution diagnostics
curl -s "$NEGENTROPY_LAB/api/authority/slot-contributions/$CONTRIBUTION_ID/diagnostics" | jq .
```

Expected checks:

- `GET /api/authority/slots/:slotId` returns the slot definition with `layer: L5`, `allowExternal: true`, `defaultGateMode: SHADOW`.
- `GET /api/authority/slot-contributions` lists the OpenSlack contribution with `providerKind: external` and `gate.mode: SHADOW`.
- `GET /api/authority/slot-contributions/:contributionId/diagnostics` shows no degraded triggers and confirms the contribution does not request `authorityWriterHandle` or `proposeMutation`.

## Inspecting OpenSlack evidence (real commands)

Once the slot contribution is active, inspect the evidence OpenSlack produces using existing CLI commands. These commands are real today.

List workflow runs:

```bash
openslack collaboration workflow runs list
```

Show a single run's progress as JSON:

```bash
openslack collaboration workflow runs show <runId> --detail progress --format json
```

Inspect a full run bundle as JSON:

```bash
openslack collaboration inspect <runId> --format json
```

Inspect PR evidence:

```bash
openslack pr status <n>
openslack pr doctor <n>
```

Check profile-sync projection status:

```bash
openslack collaboration workflow profile-sync status
```

These outputs form the evidence that OpenSlack exports to Negentropy-Lab. They are projection-only; they do not mutate Negentropy-Lab `AuthorityState`.

## Rollback

If the integration degrades:

1. Deactivate the contribution in Negentropy-Lab via the slot-contributions deactivation endpoint.
2. Stop the OpenSlack export on the OpenSlack side. Once `openslack integration negentropy export-slot` is implemented, delete or disable the exported manifest.
3. OpenSlack continues to run standalone; no Negentropy-Lab state is owned by OpenSlack.

## See also

- `docs/product/negentropy-lab-integration.md` — product positioning
- `docs/developer/negentropy-slot-adapter.md` — manifest and evidence schema
- `docs/security/negentropy-slot-boundary.md` — hard boundary rules
- `docs/product/profile-sync.md` — profile-sync projection details
