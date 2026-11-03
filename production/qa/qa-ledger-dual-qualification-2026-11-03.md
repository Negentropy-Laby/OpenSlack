---
schema: openslack.document.v1
id: qa-ledger-dual-qualification-2026-11-03
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: qa
updated: 2026-11-03
sources:
  - production/qa/qa-ledger-cleanup-post420-2026-10-11.md
  - docs/architecture/contracts/task-claim-v2-c0.md
  - docs/architecture/adr/adr-0005-task-claim-v2-single-host.md
  - services/cleanup-broker/README.md
---

# Cleanup / Go R-EXT / Claim C0 execution ledger

## Scope and source identity

Implementation started from merged main
`b8b11ed64238c3b622d110e5d2d11944a342609e`, verified against origin and GitHub.
The canonical checkout and retained #415 worktree were preserved. New Cleanup,
Claim C0 and formally claimed R-EXT worktrees are separate. These local draft
changes are not yet a clean merged execution candidate or qualified artifact.
No old CI, private-target Permit or deployment approval applies to new bytes.

The CDD skills are local planning/review support. These are project-owned
contracts/tests/evidence, not CDD framework copies. OpenSlack uses Issues; no
Story/TR registry, Source mirror or new governance framework was manufactured.
Proposed ADR writing, independent recommendation, acceptance, CI, human GitHub
review, merge, installation, live qualification and release remain separate.

## Actual task and delivery records

All new Issues below were created through the package task preview/create path
with `openslack-agent-operator[bot]`; manifests validated and start **blocked**.
No blocked task was labeled ready to bypass a missing dependency or identity.

New preparation deliveries (not qualification completion) were created through
the supported App-authenticated delivery service:

- [#434](https://github.com/Negentropy-Laby/OpenSlack/pull/434), public-target
  preparation, head `39a9d1a4b57c0f618f39eee7723a8893ef2d9a2c`, tree
  `7bef331786f26f08723c05a992a3f35879d53a72`;
- [#435](https://github.com/Negentropy-Laby/OpenSlack/pull/435), #411 safe
  preparation, head `b8bf3fa5da19eefb33ddfbeb7aa386e7c0b03fd6`, tree
  `d6723f311ca3683017511c498f05e327e1e194dc`.

[#436](https://github.com/Negentropy-Laby/OpenSlack/pull/436) delivers the C0
proposal and this ledger. Its initial App delivery observed equal published
branch/PR head `827f4ab17083b6607cbb2256e909ccd0ff56e594` at
2026-11-03T10:38:42.346Z; this follow-up records the actual new PR association.
It does not reuse the initial head's checks for a later metadata commit. The
four exact normative R5 digests below remain unchanged.

Both live readbacks were OPEN/Draft, base main, author
`app/openslack-agent-operator`, with PR and published branch heads equal.
New-head checks had started, not completed. Local task drafts remain preserved
outside the selected delivery; a separate clean detached checkout published
the exact Cleanup commit without deleting those drafts. No qualification or
runtime task was closed, no approval was submitted and nothing was merged.

| Issue                                                           | Purpose                                              | Current gate                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [#427](https://github.com/Negentropy-Laby/OpenSlack/issues/427) | Cleanup public-repository real qualification         | Administrator installation, registry, App scope, activation and one-use Permits                    |
| [#428](https://github.com/Negentropy-Laby/OpenSlack/issues/428) | Claim v2 C0 contract and review                      | Exact R5 recommendations favorable; maintenance assignment, delivery and separate decision acceptance pending |
| [#429](https://github.com/Negentropy-Laby/OpenSlack/issues/429) | C1 state kernel and TS/Go conformance                | Accepted C0; not implemented or ready                                                              |
| [#430](https://github.com/Negentropy-Laby/OpenSlack/issues/430) | C2 PostgreSQL/local sessions                         | Verified C1 and separate implementation scope                                                      |
| [#431](https://github.com/Negentropy-Laby/OpenSlack/issues/431) | C3 separate claimed cleanup admission                | Qualified C2 and separate action/policy/grants                                                     |
| [#432](https://github.com/Negentropy-Laby/OpenSlack/issues/432) | Public target source/tests/documentation preparation | Registered exact-scope maintenance remains unassigned; user-delegated draft is not a runtime Claim |
| [#433](https://github.com/Negentropy-Laby/OpenSlack/issues/433) | Narrow checkpoint replay defect                      | Separate runtime repair scope/review, not #411 permission                                          |

[PR #425 final merged summary](https://github.com/Negentropy-Laby/OpenSlack/pull/425#issuecomment-6600245982)
and [PR #426 final merged summary](https://github.com/Negentropy-Laby/OpenSlack/pull/426#issuecomment-6600246799)
were appended; historical Draft/failure text was not overwritten. #425 merge is
`b8b11ed64238c3b622d110e5d2d11944a342609e`, head
`b5496a4759df30965d03bb0e7146c0412613dc34`; both share tree
`e4d9a563c8c9e2d788fa14172fd5bea51de8bba0`. #426 merge is
`e3e2584d1349c1578e5d229e0d460feaf494f83d`, head
`4b273be04e70731f71191b99d72fee8001c4037f`. Live rollups were complete/success
with expected tag-publish skips. This observation is not this round's local
full suite or current-draft hosted CI.

[#415 completion association](https://github.com/Negentropy-Laby/OpenSlack/issues/415#issuecomment-6600247396)
preserves open + done. Existing `markIssueDone` does not close the Issue.
Its exact legacy ref read returned HTTP 404; nothing was deleted, and no
unobserved local run/lease was declared safely terminated. Unknown historical
runtime remains reconciliation work, not a reason to redo merged repair.

## Cleanup preparation and live gates

The repository read observed the exact public target
`Negentropy-Laby/openslack-cleanup-qualification-public`, ID `1381124543`, node
`R_kgDOUlJJvw`, public, default main and automatic branch deletion false.
That read is **not** a deletion-App installation/permission observation.

The narrow source patch changes only the fixed administrator-contract target,
fixture public-visibility check and current instructions/tests. TS/Python
projections use the existing generator. The real registry and historical digest
`33a9b46866fedd768cb859abfd36341159fc0f3a3e306462575f1f34af7e7ebc`
remain unchanged and bind the old private target. Production workspace admission
therefore correctly rejects the public target. No speculative pin or grant was
installed. Private repository/history/Permits are retained, never migrated.

| QA classification / layer                   | Actual result                                                                                                                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config / fixture regression                 | PASS: test first rejected the new legal public fixture with FIXTURE_REPOSITORY_MISMATCH; source fix then passed 51 cases                                                                      |
| Auth / parser / path                        | PASS: original production bundle rejects old registry and private selection; separate test-only synthetic module preserves real parser/FD/path coverage, never an administrator authorization |
| Final related regression                    | PASS: 148 cases in four files, one final serial run, existing unprivileged test UID, Node 24.18.1/Bun 1.4.0/Python 3.12.9; no production identities created                                   |
| Generated contract                          | PASS: existing Python generator then --check; real registry checksum parity retained                                                                                                          |
| Full typecheck/build                        | Build PASS after clean frozen dependency installation; full typecheck in progress at initial ledger write                                                                                     |
| Independent security review                 | Initial LOW test-guard ambiguity fixed; exact selection error and registry NOT_OBSERVED added; reviewer statically confirmed resolution; no runtime qualification inferred                    |
| Installed distinct-UID isolation            | BLOCKED: current WSL list lacks previously recorded OpenSlack-Cleanup-Qual; old UID/installation snapshot is not current evidence                                                             |
| Public App / protection / task view         | BLOCKED: independent administrator evidence not supplied for current target                                                                                                                   |
| Fresh activation / Permit / actual deletion | NOT_RUN; zero activation/Permit issuance/deletion this round                                                                                                                                  |
| New head hosted CI / human review / merge   | NOT_RUN; merged-main CI is historical baseline only                                                                                                                                           |

The final 148-case command was:

```text
vitest run cleanup-workspace-administration.test.ts
  cleanup-qualification-fixtures.test.mjs cleanup-administration-python.test.ts
  cleanup-broker-authorization.test.ts --cache=false --reporter=dot --fileParallelism=false
```

Paths are the existing `packages/pr/src/__tests__/` files. The test runtime was
an unmodified copy of the already installed Python 3.12.9 in a temporary test
directory accessible to the existing test UID. No system Python, account,
permissions or qualification installation was changed.

Earlier failures remain recorded: default Python 3.10 cannot satisfy >=3.11;
root-owned local fixtures hit PERSISTENT_DIRECTORY_OWNER_OR_MODE; simultaneous
fixture runs produced four five-second timeouts. No timeout or assertion was
relaxed. Correct interpreter plus serial execution under the intended non-root
fixture context passed; that does not erase those failed executions.

## #411 preparation: actual claim, zero provider attempts

The production resolver matched existing `codex_qualification_rext`, fixed run
`RUN-20260914002215-zpf83u`, active registry, correct repository and capabilities.
The first real claim was denied because broad task globs intersected secret-file
denies. The manifest was formally narrowed to exact filenames within the approved
paths; registry and forbidden paths were unchanged. Production authorization
then allowed, and the supported Task Loop granted the actual claim:

- ref `refs/heads/openslack/claims/issue-411`;
- observed grant `2026-11-03T09:26:18.725Z`;
- successful heartbeat expiry `2026-11-03T11:32:58.595Z` (historical observation,
  not an unlimited validity guarantee);
- official branch `agent/codex_qualification_rext/TASK-2026-314162/RUN-20260914002215-zpf83u`.

See [actual claim record](https://github.com/Negentropy-Laby/OpenSlack/issues/411#issuecomment-6600248020).
This is v1 Task Loop evidence, not Claim v2 proof. Runtime parser success alone
does not prove ctx.agent provider resolution; verify the actual adapter/binding
and token-counting semantics before any external attempt.

**Code blocker #433:** using real golden contract observations, initial
checkpoint revision 2/generation 0 plus resumed control revision 3/generation 1
is passed through the production checkpoint evidence builder. The production
validator rejects it with WORKFLOW_CHECKPOINT_CONTRACT_INVALID / Observation
variant is invalid. Sealed worker checkpoint duplicate replay follows that
shape. This is a deterministic mechanism reproduction, not complete database
execution or proof of every possible caller. Do not weaken the validator.

The fixture/driver/local-regression preparation continues in its exact paths.
Full sealed initial → pending → human decision → canonical resume is BLOCKED on
the separately scoped runtime repair. No state was seeded to claim recovery.
No source candidate may be swapped during an external run.

| External criterion                                  | Actual state                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| Provider attempts / token ceilings                  | 0 / 4 attempts; max 8,192 per attempt and 32,768 total remain unchanged |
| Provider counting/pricing semantics                 | NOT_RUN for real provider; token ceiling is not a USD bill ceiling      |
| Exact human-attested effect approval                | NOT_RUN; agents supply no approval phrase                               |
| Restart while waiting / after completion            | NOT_RUN                                                                 |
| Authority/binding/receipt/lease/retired-TS failures | Real qualification NOT_RUN; local regressions separate                  |
| Fixed drain observations                            | 0 / 40, NOT_RUN; future t0+15k seconds, k=1..40; no backfill            |
| Overall Go R-EXT                                    | BLOCKED; not passed                                                     |

## Claim C0 reviews and limits

C0 remains In Review; ADR-0005 is Proposed, not accepted. R1 independent Full TD
review rejected the purported freeze: per-operation schema/errors and closing
state transitions were underspecified. R2 adds data-only closed schema, explicit
FSM/error/durable-rejection order, raw Issue projection examples and canonical
bytes. Root's strict schema compile/digest checks do not implement a state kernel,
TS/Go parity, authenticated session or database transaction. At that historical
R2 observation the independent recommendation was still pending. The later
exact R5 recommendations below are favorable; separate exact-byte ADR
acceptance remains pending.

The first server is Linux/WSL2 single host. Future C3 uses independent
pr.cleanup_branch_claimed.v1; it is not registered/enabled. Current Permit-only
action, source-task blockers and legacy Task Loop writers remain unchanged.
No C1–C7 implementation, database, rollout or migration occurred.

## Release mapping and unresolved documentation

Issues #239–#248 were read, not executed. The parent remains open; child release
gates remain blocked. Preserve July release observations as history: old
model_endpoint-not-configured text is not a fresh provider/configuration check.
No signed release, clean-machine/npm/bot/onboarding/merge/task capstone or extra
Harness model qualification is promoted by this work.

The two named Windows plan originals were not present at their exact paths
under C:\Users\WSMAN\.claude\plans in this inspection. They were not recreated,
relocated or overwritten. This repository ledger retains the execution record;
syncing those originals remains blocked until the actual retained files are
located. R-REC/R-DOC and historical failures remain unresolved, not checked off.

## Administrator and human handoff (not executed)

1. Identify actual existing target host/UIDs and prove current state/processes.
   Preserve ledger/worker journal/consumption history during reviewed stop/backup/
   upgrade. Never use the never-started-only backup route on a started install.
2. Independently review exact public registry scope and resulting actual pin;
   install deletion App only for the fixed target with unchanged permission
   ceiling. Prepare independent negative targets/protection and full task view.
3. Obtain actual new boot nonce/generation, activate in fixed governance main and
   issue fresh one-use precise Permits. Do not extend private-target old permits.
4. After preparation/repair review, CI and authorized merge, freeze clean source,
   bundle, image digests and allowlist. Then agents run all real qualification.
5. Humans provide exact effect decision and later effective GitHub review; chat
   write authority, local tests and bot comments replace neither.

Until all required rows close, the whole plan is **not complete**. No release,
production, native Windows Broker or Claim v2 implementation claim is made.

## Current preparation closure (2026-11-03, later observation)

This section supersedes the initial in-progress rows only for the exact scoped
local work below; it does not promote a live or release gate.

- Cleanup: final four-file 148/148 and eight-file library/CLI 245/245 local
  regressions passed. The latter includes real temporary bare-Git/clone tests,
  not GitHub deletion. Full typecheck/build and relevant ESLint passed.
- Cleanup Broker: Go 1.26.5, `GOWORK=off go test -race -count=1 ./...` and
  `GOWORK=off go vet ./...` passed across 11 packages. The first race run failed
  because a committed private-batch evidence test compared its historical target
  with the current public contract. After formal exact-path #432 amendment,
  only the test was corrected to an independent historical name/ID, and a paired
  public-target transplant must fail at the exact binding guard. No policy,
  registry, historical audit, production code or Permit was rewritten.
- Workflow source manifest: the named source-binding Go contract test passed
  with `-count=1`. No changed source path appeared in active manifest bindings.
- R-EXT: final affected four-file run is 87/87: 15 new test cases and 72 neighboring cases;
  not 84 plus 87. Package/script typechecks and relevant ESLint passed. Independent
  preparation review recommended APPROVED WITH SUGGESTIONS after two concrete
  findings were fixed: enum arrays could bypass unknown-attempt freezing, and a
  static node:crypto import violated sealed admission. Exact persisted-JSON and
  actual sealed-source-policy regressions first failed, then passed; the fixture
  now uses guarded awaited host Web Crypto, without weakening source policy.
  A final parent-executed repeat at 2026-11-03T10:31:41.881Z–10:31:47.410Z
  retained its actual Vitest JSON report at
  `/var/tmp/openslack-nextstage-evidence.4Jh4MDsS/rext-local-final.json`, SHA-256
  `7a166b2a9c5569cce0254d25afa1acd8f2bb940801f84d2aed11208600c3c680`.
  This is local preparation evidence, not independently rerun or live provider
  qualification. Metadata readback times do not replace execution timestamps.
- Inventory: formal generation reports Cleanup 9,134/601 and R-EXT 9,145/602
  against their separate b8b11ed6-based drafts. These are separate candidate
  inventories, not cumulative passing tests. Future merged/rebased inventory
  must be regenerated, not obtained by adding overlapping results.
- Documentation generation/verification passed separately for the Cleanup and
  C0 drafts. Generated views were produced by supported commands, not edited.

The current host observation is more precise than the missing-distro finding:
WSL hostname DESKTOP-2SJF7KU has existing broker/agent accounts 24001/24002 and
prepared directories, while the current reviewed contract selects 44180/44181.
The fixed Broker binary/config and runtime directory were absent on this root.
This does not prove another installation never started or that all prior state
is empty. No account, system permission, installation or state was changed.
The root process also has Docker access and is not an isolated qualification
Agent. Administrator confirmation of the actual approved target remains required.

### C0 exact R5 review input

Full independent TD review, required Product technical consultation and security
review recommend the proposal; they do not accept ADR-0005. The exact original
set is retained at `/tmp/openslack-c0-r5-reviewed.z7Yew8ei`, with earlier R3/R4
sets separately retained. R1/R2 have only recorded hashes/findings; their full
intermediate drafts were not preserved. This limitation is not retroactively
reclassified as raw-byte retention. The original main C0 remains recoverable in
Git. None of the old recommendations is reused as acceptance.

| R5 input          | Bytes  | SHA-256                                                          |
| ----------------- | ------ | ---------------------------------------------------------------- |
| C0 Markdown       | 51,872 | 1600ede1a001dfa34a1fd7f44659e90270560fb0f36fc52c2cb862aa958c6699 |
| C0 schema         | 32,076 | 65c2c63c7f85758f3276f5231bce9f9364fc31300d69077aaf72d71160b8f806 |
| Data-only vectors | 80,089 | 380c3f7bfd0694401177712b707bee1ef76824bb11e287985217ad29a013e058 |
| Proposed ADR-0005 | 13,960 | 38c8fd437c64ca78f6cc447f42ed4b63d3ed345f78b31e714718b79cfc11cd7c |

Independent R5 data diagnostics confirmed 20 schema-bearing accepted objects,
22 canonical digests, nine raw Issue projections, two structural/four semantic
observation negatives and six selected transition invariants. These are data
conformance diagnostics, **not** independently implemented C1 TS/Go kernels.
Initial R1/R2/R3 concerns and their corrections are retained: exact schema/FSM,
operation-specific guards, observer invariants, reachable epoch/revision,
domain separation and generation/recovery semantics. No C1–C7 code was added.

Current remaining code work is explicit: #433 runtime repair, complete sealed
resume composition, a durable per-attempt live send gate and actual Go metrics
connector. Current helpers intentionally expose no live send/approval path.
Provider binding/counting, actual approvals, restart, 600-second drain and all
Cleanup live cases remain NOT_RUN/BLOCKED. Hosted checks must bind new delivery
heads; this ledger contains no new-head CI PASS or merge/acceptance assertion.
