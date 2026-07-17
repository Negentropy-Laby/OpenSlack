# Negentropy-Lab Slot Boundary

This document defines the hard security boundary between OpenSlack and Negentropy-Lab when OpenSlack contributes to the `scenario-pack.extension` slot as an external provider. OpenSlack remains a GitHub-agent workbench; Negentropy-Lab remains the authority owner and control plane. The OpenSlack v1 artifact is fixed to `SHADOW` and OpenSlack never escalates it to `ENFORCE`.

The external `SlotContribution` contract is not OpenSlack's internal plugin execution contract. A dedicated adapter projects OpenSlack evidence into the upstream slot schema; `PluginHost` does not load or execute the contribution, and the adapter is not an internal plugin loader. See [Plugin Trust Model](plugin-trust-model.md) for the separate OpenSlack-owned contract.

## Hard Rules

1. **OpenSlack does not own `AuthorityState`.** Authority state, truth triad ownership, and policy governance remain in Negentropy-Lab.
2. **OpenSlack receives no writer handle.** The adapter does not request, accept, or cache `authorityWriterHandle`, direct authority mutation routes, or equivalent control-plane credentials.
3. **OpenSlack never calls `proposeMutation` directly.** Any mutation of Negentropy-Lab authority state must be initiated by Negentropy-Lab itself, not by OpenSlack code.
4. **GitHub-side mutations stay in GitHub.** OpenSlack may create, update, or close GitHub Issues and Pull Requests as part of its normal workflow. It must not translate those GitHub mutations into direct Negentropy-Lab state mutations.
5. **Negentropy-Lab absorbs output only as evidence, projection, or governed request.** OpenSlack may export workflow run evidence, PRMS reports, profile-sync projections, collaboration event summaries, and explicit governed-action requests. Negentropy-Lab ingests these as read-only inputs and decides what to do with them.
6. **The OpenSlack artifact remains in `SHADOW`.** The external `scenario-pack.extension` contribution uses `gate.mode: SHADOW`; OpenSlack cannot emit an ENFORCE artifact or claim that Negentropy activated it.

## Authority State Boundary

`AuthorityState` is a Negentropy-Lab concept. OpenSlack does not store, replicate, or derive it. OpenSlack does not hold the authority writer handle and does not invoke `proposeMutation` or any equivalent control-plane mutation API. If a future integration requires OpenSlack to request a policy change in Negentropy-Lab, that request is emitted as a governed action request and processed by Negentropy-Lab's own decision flow.

## Mutation Boundary

OpenSlack mutations are limited to GitHub-native objects:

- GitHub Issues
- GitHub Pull Requests
- GitHub comments, labels, and review threads
- Repository files through normal GitHub PR workflows

These mutations are OpenSlack's operational scope. They are not proxies for Negentropy-Lab authority mutations. The adapter may record that a GitHub mutation occurred as evidence, but it does not forward it as a control-plane command.

## Absorption Boundary

Negentropy-Lab may absorb OpenSlack output in exactly these forms:

| Form | Examples |
|------|----------|
| Evidence | Workflow run JSON, PRMS report payload, agent decision/handoff YAML, audit JSONL |
| Projection | Profile-sync render of `.github/profile/README.md`, room summaries, activity digest |
| Governed request | Explicit human-approved action request with approval provenance |

Negentropy-Lab decides whether to accept, transform, or reject each contribution. OpenSlack does not assume ingestion, activation, or policy effect.

## Gate Mode

The target slot is defined with `defaultGateMode: SHADOW`. The OpenSlack contribution manifests with `gate.mode: SHADOW`. In `SHADOW` mode:

- Negentropy-Lab can observe and validate the contribution without applying it to authority decisions.
- OpenSlack continues to operate as a standalone GitHub workbench.
- No OpenSlack workflow can trigger an authority-side enforcement action.

Any Negentropy-side lifecycle action remains a governed Negentropy decision and
is not initiated or inferred by OpenSlack. The OpenSlack v1 contribution
artifact itself remains SHADOW even when live Negentropy diagnostics report a
lifecycle state.

## Human Approval Gate

Any governed action request that crosses from OpenSlack into Negentropy-Lab requires human approval. See [Human Approval](human-approval.md) for the full definition, required decision format, and agent constraints. Bots and agents may prepare the request and record the evidence; they may not originate the approval decision itself.

## Violations

Violating any hard rule in this document is a governance failure. If OpenSlack code obtains a writer handle, calls `proposeMutation`, or attempts to mutate Negentropy-Lab authority state directly, the integration must be disabled and the incident reviewed before any further contribution is accepted.
