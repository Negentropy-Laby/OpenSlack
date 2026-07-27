# AI organization rehearsal checklist

Record the exact commit and date for every checked item. Do not reuse evidence from an older head.

## Local contract — required for `LOCAL_PASS`

- [ ] `ai-org-transformation` is discoverable and validates.
- [ ] The manifest contains `Intake`, `Discover`, `Select`, `Design`, `Validate`, `Deliver` in order.
- [ ] Six fixture agent results pass the Runtime schemas.
- [ ] Discover and Validate use concurrency 2; observed fake-launcher concurrency never exceeds 2.
- [ ] The result contains the seven filenames in canonical order.
- [ ] Input, workflow result, recorded manifest, and projection pass their JSON schemas.
- [ ] Two fixture runs in separate empty output directories have identical manifest, projection,
      and artifact digests.
- [ ] Fixture mode rejects live-only arguments.
- [ ] Missing `--repo` or `--execute` blocks live mode before output or external mutation.

## Governance — required before merging a workflow change

- [ ] The workflow reports no side effects.
- [ ] No agent or rehearsal route can approve a GitHub review.
- [ ] No agent or rehearsal route can merge or push directly to `main`.
- [ ] The PR targets canonical `main` and is authored by the configured bot/agent identity.
- [ ] Workflow-Trust evidence is bound to the current exact PR head.
- [ ] Required checks and review conversations are current.
- [ ] An independent human approval exists for the current head before merge.

## Live qualification — required for `GITHUB_REHEARSED`

- [ ] The six Red Zone agent registry entries have separately passed their current-head review.
- [ ] Agent Runtime diagnostics pass for the configured provider.
- [ ] The explicit rehearsal repository exactly matches `origin`.
- [ ] Local `main` equals the GitHub App-observed current remote `main` SHA.
- [ ] GitHub App installation identity is active and the two required task labels exist.
- [ ] One bot-authored parent Issue and seven bot-authored child Issues are recorded.
- [ ] The draft PR targets `main`, is bot-authored, and its head equals the recorded branch commit.
- [ ] The draft PR remains unapproved until an authorized independent human acts in GitHub.
- [ ] `openslack pr doctor <N>` truth is recorded without calling checks equivalent to approval.

## Interview readiness

- [ ] The offline recorded fallback renders without a model provider or network.
- [ ] Live and recorded artifacts use the same seven-file contract.
- [ ] All configured estimates are labeled; unproved revenue is `unknown`.
- [ ] Qoder permission, OpenSlack action confirmation, and GitHub human approval are explained as
      separate gates.
- [ ] Notification deep-dive says `accepted != delivered` and does not claim default cutover or
      `LIVE_VERIFIED`.
