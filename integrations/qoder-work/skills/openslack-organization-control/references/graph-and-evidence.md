# Graph and Evidence

Organization Graph is a bounded, rebuildable projection. It does not own source mutations.

## Read sequence

1. Use `openslack_list_scenarios` to select the relevant definition or instance.
2. Use `openslack_query_graph` to find bounded nodes, edges, owners, and status.
3. Use `openslack_explain_graph` for authority, version, source events, evidence, projector
   version, completeness, and truncation.
4. Use specialized tools when a graph result points to a workflow, PR, room, outcome, or
   notification.

Follow the connected tool schema exactly. Narrow depth, node count, filters, or scenario scope
when a response is truncated or too large.

## Evidence quality

- `github` authority owns observed Issue, PR, Check, Review, and Merge facts.
- `openslack` authority owns local workflow, event, handoff, decision, plan, and receipt facts.
- `demo_fixture` is visibly non-live.
- Missing sources make the projection incomplete; they do not become empty authoritative data.
- A graph hash proves canonical projection integrity, not external truth by itself.
- A cursor is opaque and bound to one normalized query.
- Closed nodes/edges preserve history and must not be reported as active.

## Hard claim checks

Before claiming:

- **approval**: require current-head human-review evidence;
- **delivery**: require vendor-delivery evidence, not only acceptance;
- **acceptance**: require authoritative acceptance evidence;
- **outcome**: require evidence-backed outcome metrics and basis;
- **owner**: require an authority or OpenSlack coordination reference;
- **complete**: check missing sources and blockers.

If evidence is incomplete or stale, keep the exact returned status and use `unknown` for the
unsupported claim.
