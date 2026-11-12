---
schema: openslack.document.v1
id: qa-ledger-dual-qualification-2026-11-03
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: qa
updated: 2026-11-10
sources:
  - production/qa/qa-ledger-cleanup-post420-2026-10-11.md
  - docs/architecture/contracts/task-claim-v2-c0.md
  - docs/architecture/adr/adr-0005-task-claim-v2-single-host.md
  - services/cleanup-broker/README.md
---

# Cleanup / Go R-EXT / Claim C0 execution ledger

## Scope and source identity

This ledger retains dated observations and exact-byte evidence. Current work,
execution and release gates come only from
`memory_bank/control-plane.json#/assignments` and its generated projections.
Local regression, hosted CI, source delivery, human GitHub review, ADR decision
acceptance, installation and real qualification are separate evidence classes;
a result here establishes only the named class and candidate. R6 is source and
documentation maintenance, not C1–C7 implementation or qualification acceptance.
Original failures, Unknowns and unavailable originals remain historical facts.

The sections through the hosted-failure record are November 3 observations;
the November 7 appendices supersede their state mirrors without revising those
old results.

Implementation started from merged main
`b8b11ed64238c3b622d110e5d2d11944a342609e`, verified against origin and GitHub.
The canonical checkout and retained #415 worktree were preserved. New Cleanup,
Claim C0 and formally claimed R-EXT worktrees are separate. Those local draft changes had not yet become a clean merged execution
candidate. Old CI, private-target Permits and deployment approvals were bound
to their original inputs.

The CDD skills are local planning/review support. These are project-owned
contracts/tests/evidence, not CDD framework copies. OpenSlack uses Issues; no
Story/TR registry, Source mirror or new governance framework was manufactured.

## Actual task and delivery records

All new Issues below were created through the package task preview/create path
with `openslack-agent-operator[bot]`; manifests validated and start **blocked**.
No blocked task was labeled ready to bypass a missing dependency or identity.

Initial preparation deliveries were created through
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

At the initial November 3 readback both preparation PRs were OPEN/Draft, base main, author
`app/openslack-agent-operator`, with PR and published branch heads equal.
New-head checks had started, not completed. Local task drafts remain preserved
outside the selected delivery; a separate clean detached checkout published
the exact Cleanup commit without deleting those drafts.

| Canonical assignment | Evidence navigation                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issue-427`          | [Issue #427](https://github.com/Negentropy-Laby/OpenSlack/issues/427), [#434 source delivery](https://github.com/Negentropy-Laby/OpenSlack/pull/434) |
| `issue-428`          | [Issue #428](https://github.com/Negentropy-Laby/OpenSlack/issues/428), [#436 contract review](https://github.com/Negentropy-Laby/OpenSlack/pull/436) |
| `issue-429`          | [Issue #429](https://github.com/Negentropy-Laby/OpenSlack/issues/429)                                                                                |
| `issue-430`          | [Issue #430](https://github.com/Negentropy-Laby/OpenSlack/issues/430)                                                                                |
| `issue-431`          | [Issue #431](https://github.com/Negentropy-Laby/OpenSlack/issues/431)                                                                                |
| `issue-432`          | [Issue #432](https://github.com/Negentropy-Laby/OpenSlack/issues/432), [#434 source delivery](https://github.com/Negentropy-Laby/OpenSlack/pull/434) |
| `issue-433`          | [Issue #433](https://github.com/Negentropy-Laby/OpenSlack/issues/433), [#435 source delivery](https://github.com/Negentropy-Laby/OpenSlack/pull/435) |
| `issue-438`          | [Issue #438](https://github.com/Negentropy-Laby/OpenSlack/issues/438), [#435 source delivery](https://github.com/Negentropy-Laby/OpenSlack/pull/435) |

These IDs resolve to the sole current assignment authority; the table is an
evidence index, not a second copy of live titles, statuses or blockers.

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

Scope and implementation limits belong to the
[Proposed ADR](../../docs/architecture/adr/adr-0005-task-claim-v2-single-host.md#status)
and [In Review C0 contract](../../docs/architecture/contracts/task-claim-v2-c0.md#status-and-separation).

## Release mapping and unresolved documentation

Issues #239–#248 were read, not executed. The parent remains open; child release
gates remain blocked. Preserve July release observations as history: old
model_endpoint-not-configured text is not a fresh provider/configuration check.

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

## Historical preparation closure (2026-11-03, later observation)

This later November 3 observation superseded the initial in-progress local rows
for the exact scoped candidates below.

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
review recommend the proposal; they do not accept ADR-0005. The original record named
`/tmp/openslack-c0-r5-reviewed.z7Yew8ei`, with earlier R3/R4 sets separately
recorded. The four R5 inputs below are independently recoverable at immutable
commit `5683d1a7843a8f3b0fbea1383d3054ff083f0058`; this update does not
assert that ephemeral evidence directories still exist. R1/R2 have only recorded hashes/findings; their full
intermediate drafts were not preserved. This limitation is not retroactively
reclassified as raw-byte retention. The original main C0 remains recoverable in
Git. None of the old recommendations is reused as acceptance.

| R5 input                                                                                                                                                                    | Bytes  | SHA-256                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| [C0 Markdown](https://github.com/Negentropy-Laby/OpenSlack/blob/5683d1a7843a8f3b0fbea1383d3054ff083f0058/docs/architecture/contracts/task-claim-v2-c0.md)                   | 51,872 | 1600ede1a001dfa34a1fd7f44659e90270560fb0f36fc52c2cb862aa958c6699 |
| [C0 schema](https://github.com/Negentropy-Laby/OpenSlack/blob/5683d1a7843a8f3b0fbea1383d3054ff083f0058/docs/architecture/contracts/task-claim-v2-c0.schema.json)            | 32,076 | 65c2c63c7f85758f3276f5231bce9f9364fc31300d69077aaf72d71160b8f806 |
| [Data-only vectors](https://github.com/Negentropy-Laby/OpenSlack/blob/5683d1a7843a8f3b0fbea1383d3054ff083f0058/docs/architecture/contracts/task-claim-v2-c0-vectors.json)   | 80,089 | 380c3f7bfd0694401177712b707bee1ef76824bb11e287985217ad29a013e058 |
| [Proposed ADR-0005](https://github.com/Negentropy-Laby/OpenSlack/blob/5683d1a7843a8f3b0fbea1383d3054ff083f0058/docs/architecture/adr/adr-0005-task-claim-v2-single-host.md) | 13,960 | 38c8fd437c64ca78f6cc447f42ed4b63d3ed345f78b31e714718b79cfc11cd7c |

R5 data diagnostics and their scope remain bound to those file digests. R6
counts come from the verification command's data-derived report, not a manually
maintained copy here. Neither set is a C1 TS/Go state-kernel execution result.
Initial R1/R2/R3 concerns and their corrections are retained: exact schema/FSM,
operation-specific guards, observer invariants, reachable epoch/revision,
domain separation and generation/recovery semantics. No C1–C7 code was added.

At that November 3 observation, remaining code work was: #433 runtime repair, complete sealed
resume composition, a durable per-attempt live send gate and actual Go metrics
connector. The helpers then exposed no live send/approval path.
Provider binding/counting, actual approvals, restart, 600-second drain and all
Cleanup live cases remain NOT_RUN/BLOCKED. Hosted checks in that record applied only to their named delivery heads.

## Later hosted failures and exact-scope follow-up

Both first Windows release-scope jobs failed in `Qualify governed PR branch
cleanup`. The failures are distinct and are not erased by local or later PASS.

- [#434 original job](https://github.com/Negentropy-Laby/OpenSlack/actions/runs/41620570798/job/125864915503):
  associated head `39a9d1a4b57c0f618f39eee7723a8893ef2d9a2c`, actual synthetic
  merge checkout `5db50848cf480a7be0867b0c3d378d643691f44e`. The test-only
  workspace builder used POSIX string replacement to derive a Windows dist
  path and compared raw separators. A new exact win32/POSIX path case first
  failed that expression, then passed after native joins and normalized exact
  two-module matching. No broad interception, skip, timeout or production
  permission change was added. Independent bounded review favored test hash
  `bf69c0703284fd4929d1206283ef8963e03b7cedbfb2f9509f1a84740e02f41e`.
- The additive fix is published to the same #434, not a replacement PR: head
  `242eb95b563ea268b10b49b86fceacab492272be`, tree
  `5146f5f32c975a5d14d8cbaac9cb106a9e93f669`; bot update-only readback confirmed
  local/remote/PR equality at 2026-11-03T11:13:46.357Z. New CI is pending, not
  inherited from the first head. Final four-file local follow-up is 149/149;
  report `/var/tmp/openslack-nextstage-evidence.4Jh4MDsS/cleanup-local-final-149.json`,
  SHA-256 `1919ed3df0e50af3367d634f2393237a54314d4f40d0cfd64ae2823ad1f518ff`.
  Formal inventory is now 9,135/601 on this separate branch. Full typecheck,
  relevant ESLint, docs verification, Go race/vet passed again. The earlier
  eight-file 245-case run remains earlier-head evidence, not a fresh rerun.
- [#435 original job](https://github.com/Negentropy-Laby/OpenSlack/actions/runs/41620581191/job/125864949850):
  associated head `b8bf3fa5da19eefb33ddfbeb7aa386e7c0b03fd6`, actual synthetic
  merge checkout `e083213262fbbe4bfa84a877c636037fbd30233e`, Windows Server 2022,
  actual Node 24.18.1. `ignores an unknown action without mutating delivery
state` failed `read ECONNRESET` after logging port 3389. The two WatchDaemon
  blobs are identical at main, PR head and actual checkout. Its request already
  disables pooling and awaits response end before stop; teardown is not a proven
  cause. Random 3101–4100 test endpoints, missing startup rejection and response
  error handling are concrete gaps, but exact TCP reset origin is unresolved.
  Failed step: 1 failed / 3,319 passed / 12 skipped. Retained original step text
  SHA-256 `1dd4759f911427f74df25f6e26db5a9de5ae82c45adbfc68f83f9e63d419ec69`,
  144,669 bytes. No blind rerun or error suppression occurred.

The supported task preview/create path published #438 / TASK-2026-198109 as
blocked, with only the two WatchDaemon paths and explicit TypeScript/Node/test
requirements. It was then a separate repair proposal, outside the #411 qualification
principal. Its later source delivery is indexed by the canonical assignments.

Production `pr workflow-governance 435` created bot-owned
[#437](https://github.com/Negentropy-Laby/OpenSlack/issues/437), bound to current
head/base and `sha256:9b7908755e427b887ff45ff14f3a4c21bd06111dd7fdc76404e5a33c30a9cb46`.
Readback/doctor shows that governance-Issue gate PASS, but no human Workflow-Trust
decision or approval existed at that observation.

## 2026-11-07 source-delivery and lifecycle reconciliation

This read-only GitHub observation refreshes the canonical assignment mirror;
it did not close/reopen Issues, renew/delete a Claim or run provider, effect,
installation or qualification operations. The original November 3 state remains
retrievable at the immutable [R5 control-plane snapshot](https://github.com/Negentropy-Laby/OpenSlack/blob/5683d1a7843a8f3b0fbea1383d3054ff083f0058/memory_bank/control-plane.json).

Merged preparation/repair delivery is independently recorded by
[PR #434](https://github.com/Negentropy-Laby/OpenSlack/pull/434) at
`c54833096435ff1d4af6d60f7c4ffea00707aa92` and
[PR #435](https://github.com/Negentropy-Laby/OpenSlack/pull/435) at
`7525f25ec9e23beb788c035cc213832147da0ce3`. Their final source-head checks and
recorded human reviews belong to those deliveries, not to this new candidate.

The latest observed legacy [heartbeat](https://github.com/Negentropy-Laby/OpenSlack/issues/411#issuecomment-6602529066)
expires at `2026-11-03T13:23:46.973Z`. Its ref remains present at
`b8b11ed64238c3b622d110e5d2d11944a342609e`; neither fact proves a current
execution. Assignment `issue-411` is blocked on actual qualification evidence.

Merged human-delegated source work without a registered Agent Claim is recorded
as `reconciliation_required` rather than fabricated `done` execution. This
applies to the still-open maintenance Issues #432/#433/#438. Issue #427 is
closed while independent Cleanup acceptance evidence remains absent; that
lifecycle mismatch is also reconciliation work. No completed source work is
re-advertised as Draft CI or source review pending.

Assignment `issue-244` records the actual verification time and its limited
Issue/evidence scope. No current endpoint configuration conclusion is inferred.
The R6 contract repair and exact decision acceptance remain separate for #428.

## R6 repair of the seventeen review findings

R6 continues the original #436 through human-delegated source maintenance and
configured bot delivery. It does not borrow a qualification identity or modify
its registry. R5 review recommendations remain bound to the immutable four-file
set above. R6 requires its own independent review; GitHub approval, document
merge and exact-byte ADR decision acceptance are distinct gates.

| Finding | R6 disposition                                                                                                           | Verification or authority                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1       | Corrected expired execution mirror; merged #435 source evidence replaces obsolete Draft/checkpoint/WatchDaemon blockers. | `issue-411`, dated GitHub/heartbeat observation; actual qualification blockers retained.                                             |
| 2       | Recorded #434 source delivery; maintenance lifecycle awaits reconciliation rather than a fabricated Claim.               | `issue-432`; related `issue-427` closed-without-qualification mismatch retained.                                                     |
| 3       | Manifest properties reference pinned v1 schema; C0 lifecycle, set and lease transformations remain explicit.             | v1 parser/schema compatibility, task ID, lifecycle and lease boundary regressions.                                                   |
| 4       | `docs:verify` enforces strict current-byte codec/schema/vector checks.                                                   | Digest/length/Base64/Unicode/number/ref/pin corruption, targeted negatives, same-process mutation and actual-entrypoint regressions. |
| 5       | Refreshed structured verification time and limited evidence scope.                                                       | `issue-244`; release gate refers to that assignment.                                                                                 |
| 6       | Restored ADR series owner `architecture`.                                                                                | ADR frontmatter; Proposed acceptance status retained.                                                                                |
| 7       | Shared operation vocabulary.                                                                                             | `$defs.operation` used by request and receipt.                                                                                       |
| 8       | Shared task identity base with typed closed wrappers.                                                                    | Missing/extra field regressions for both identity objects.                                                                           |
| 9       | Removed the unreferenced decimal definition.                                                                             | Strict compilation of every retained definition.                                                                                     |
| 10      | Narrative links to schema-owned closed vocabularies.                                                                     | C0 keeps behavior and validation order.                                                                                              |
| 11      | ADR links to C0-owned mechanisms.                                                                                        | Decision, motivation, alternatives and consequences retained.                                                                        |
| 12      | Completed Contract and Reference navigation.                                                                             | Registered document/link verification.                                                                                               |
| 13      | Replaced live-gate Issue table with assignment IDs and evidence navigation.                                              | Control plane remains current status authority.                                                                                      |
| 14      | Consolidated evidence-class limits in the opening scope.                                                                 | Dated failures/Unknowns retained.                                                                                                    |
| 15      | Removed hand-maintained R5 vector totals.                                                                                | Verification output derives category counts from current data.                                                                       |
| 16      | Referenced ADR/C0 scope rather than maintaining a third mechanism summary.                                               | Historical review limits remain dated.                                                                                               |
| 17      | Moved machine authorities into Reference and registered both canonical paths.                                            | Old active JSON locations removed; immutable R5 links retained.                                                                      |

The verifier checks structural negatives at their intended rule. Semantic
observation and transition examples receive structural/reference/static
consistency checks only; independent C1 semantic execution remains NOT_RUN.
All original R5 vector rows remain unchanged in R6; the new source-schema pin
is explicit metadata, not a new recommendation for old reviewed bytes.

### R6 validation record

The regression-first run exposed eleven behavior failures in the old schema
and missing gate, with one existing identity-closure check passing. The initial
expanded documentation suite then passed, including the real v1 parser. Script
typecheck and affected ESLint completed with zero errors and zero lint warnings.
Final platform runs, current-head CI and independent review are recorded below
after execution; the old head's green checks are not substituted.

### R6 exact review input

| Input                                                                                                      | Bytes | SHA-256                                                            |
| ---------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------ |
| [task-claim-v2-c0.md](../../docs/architecture/contracts/task-claim-v2-c0.md)                               | 52759 | `7d51f33ed1fe8f0fd22297317a3d7085966b0d271562810149efabdc6aaf95e7` |
| [task-claim-v2-c0.schema.json](../../docs/reference/schemas/task-claim/task-claim-v2-c0.schema.json)       | 31539 | `6084ec0310e8750ad84164a3a755f295c50522b0c249cadf7759d80ca9d39290` |
| [task-claim-v2-c0-vectors.json](../../docs/reference/vectors/task-claim/task-claim-v2-c0-vectors.json)     | 80329 | `93ecb8813f6ab35c6f2da21dbe63e978446eb6d2cbdec0c36e15b477659a0862` |
| [adr-0005-task-claim-v2-single-host.md](../../docs/architecture/adr/adr-0005-task-claim-v2-single-host.md) | 13578 | `4f4a4b47d3f23285d450c2be0b17d17fc3eafd4f78654e74db11d5101e05a0d5` |

### Initial R6 local execution and evidence reconciliation

Initial R6 source/test validation used `0412996ddaf8d8c73c63c11a18d8d548cd070c8e`.
The later evidence amendment changes only this ledger and the selected
assignments' readback times; it does not change the tested C0 machine inputs,
verifier, v1 parser, worker or test code.

| Evidence class                                            | Actual result                                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux affected documentation regression                   | PASS: 67 tests.                                                                                                                                                                                                                                |
| Native Windows affected regression                        | PASS: 65; 2 existing symlink-platform cases skipped; 0 failed. Node 24.18.1/Bun 1.4.0, fresh isolated checkout/build.                                                                                                                          |
| Linux Node 22.23.4 affected regression                    | PASS: 67 tests.                                                                                                                                                                                                                                |
| Minimum Node 22.0 actual docs entrypoint                  | PASS: `node --import tsx scripts/documentation/index.ts verify`.                                                                                                                                                                               |
| Minimum Node 22.0 Vitest tooling                          | NOT_RUN: existing Vite dependency raises ERR_REQUIRE_ESM before collection. The startup failure is retained separately.                                                                                                                        |
| First complete Linux run on named feature branch          | FAIL retained: 9,345 passed, 1 failed, 25 skipped. Existing Graph smoke uses the working branch as defaultBranch; the original branch name matches the unchanged credential filter. Both implicated files match the R5 baseline byte-for-byte. |
| Same source in detached checkout, matching hosted context | PASS: isolated Graph target, then complete Vitest 9,346 passed, 25 skipped, 0 failed. No filter, assertion, retry, worker or timeout change; original branch restored.                                                                         |
| Complete typecheck/build                                  | PASS; contract-family checks included.                                                                                                                                                                                                         |
| Affected ESLint                                           | PASS: zero errors and zero lint warnings. Node's existing config-module-type advisory is separate from ESLint findings.                                                                                                                        |
| Applicable Go source binding                              | PASS: source-manifest race regression and contract-package vet; no changed source-binding paths, so no source lock refreshed.                                                                                                                  |
| Workspace / Genesis / golden                              | PASS; golden 7/7.                                                                                                                                                                                                                              |
| Actual inventory / second generation                      | 9,371 declared cases in 606 files, including skips; second collection/status/document generation added no differences.                                                                                                                         |
| Fresh external compatibility emission                     | PASS: original Harness pinned at `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`; actual worker/plugin emission and fresh compatibility witness. Original Harness inputs were not modified.                                                         |
| Independent read-only R6 review                           | ADEQUATE, no substantive blocker. Source pin/closure/lease boundaries, R5 rows and exact R6 digest table checked; actual docs:verify passed. Final evidence amendment receives a separate SHA binding.                                         |
| Current final-head hosted CI / PRMS                       | Pending publication/readback; recorded by the existing PR's live checks and final delivery comment, not inherited from the old head.                                                                                                           |

The readback at `2026-11-07T08:47:06Z` reconfirmed all seven selected Issue
states and the same expired heartbeat. Their structured `last_verified_at`
fields now use that actual sampling time. The portfolio's separately dated
August configuration labels were not refreshed and are not a November endpoint
diagnosis. The immutable R5 originals, first-run failure logs, missing R1/R2
originals and historical Unknowns remain as previously recorded.

The completed R6 local verification and independent source review are now
recorded by `issue-428`; its remaining delivery blocker names the unmerged
document/human-GitHub-review gate, alongside exact-byte ADR decision acceptance.
Completed source review is not advertised as still pending.

### R6 codec-negative framing follow-up

A post-publication self-review found one verifier defect at source `2fe456bb`:
the second UTF-8 decoder stripped a leading BOM. A BOM-prefixed single-key
object could therefore stand in for the duplicate-key negative despite having
no duplicate keys. The new regression failed on that source. Both codec reads
now preserve the BOM so invalid framing cannot be mistaken for duplicate-key
coverage. The corpus, v1 schema, C0 contract/schema and R6 four-file digests are
unchanged. The earlier source's results remain earlier-source evidence; new
source/platform/count/current-head results are recorded separately below.

### R6 BOM-follow-up execution evidence

New code/count validation used `3c403f41ca7dda5369d6ffc70278823b56623137`;
the native affected run used its code-equivalent parent `59724033`. The final
evidence-only amendment does not alter that verifier/test code or the four
reviewed C0 machine/narrative inputs.

| Evidence class                                            | Actual follow-up result                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Targeted RED                                              | The BOM single-key substitution falsely passed the old duplicate-key negative; the new assertion failed before the decoder fix.                                                                                                                                                  |
| Linux affected documentation suite                        | PASS: 68 tests.                                                                                                                                                                                                                                                                  |
| Native Windows affected suite                             | PASS: 66; 2 existing symlink-platform cases skipped; 0 failed.                                                                                                                                                                                                                   |
| Node 22.23.4 affected suite                               | PASS: 68 tests.                                                                                                                                                                                                                                                                  |
| Complete Linux suite, detached hosted-equivalent checkout | PASS: 9,347; 25 skipped; 0 failed, from 9,372 declared cases. No assertion, retry, worker or timeout reduction.                                                                                                                                                                  |
| Full typecheck/build and affected ESLint                  | PASS; zero lint errors / zero lint warnings.                                                                                                                                                                                                                                     |
| Inventory and second generation                           | 9,372 cases / 606 files; second production collection/status/document generation added no differences.                                                                                                                                                                           |
| Compatibility and source bindings                         | Production capture verified original Harness inputs and actual worker/plugin outputs unchanged. No binding input changed, so no source lock refreshed; prior applicable Go source-contract evidence remains scoped as recorded above.                                            |
| Independent read-only follow-up                           | ADEQUATE for the BOM fix. Actual duplicates still validate as negatives; BOM, invalid UTF-8, non-JSON whitespace, trailing garbage, comments, isolated Unicode and depth failures cannot stand in for duplicate-key coverage. Final SHA binding recorded by the delivery record. |
| Final-head hosted CI / PRMS                               | Use the PR's current Checks and final delivery comment. This local record does not import earlier-head conclusions.                                                                                                                                                              |

The readback at `2026-11-07T09:24:18Z` reconfirmed the seven Issue states and
same expired heartbeat; structured verification times were refreshed. No Claim
or Issue lifecycle was mutated. The named-branch failure, earlier platform
results, Node 22.0 tooling startup failure and all older Unknowns remain
separate historical observations, rather than being relabeled by this pass.

## 2026-11-09 batch-1 implementation and scoped preflight

### Scope, authority and current source delivery

Remote `main`, `origin/main` and the clean primary checkout were independently
read back at `befa93921ec0fb83cfe1709f9ee3dd4de67d06df`. This new delivery uses
an isolated branch; the primary checkout, retained #415 worktrees, stashes and
historical claim ref were not changed. It is human-delegated documentation
maintenance, not an execution under a borrowed qualification identity or a
fabricated Agent Claim. The selected content set is the canonical control
plane, this ledger and the two generated roadmaps. No registry, policy,
provider configuration, ADR or release authority is changed.

GitHub readbacks completed by `2026-11-09T14:34:19Z` establish:

- [#436](https://github.com/Negentropy-Laby/OpenSlack/pull/436) merged at
  `2026-11-07T11:52:02Z`, merge `befa93921ec0fb83cfe1709f9ee3dd4de67d06df`,
  source head `7041cb15a3a86c963279b54c08f7d8bb26c86c2b`. Human `wsman`
  approved that head at `2026-11-07T11:49:39Z`. Required rollup contexts
  succeeded; tag publication was normally skipped. The post-merge job is not
  pre-merge approval evidence.
- The [Go/documentation job](https://github.com/Negentropy-Laby/OpenSlack/actions/runs/42360008255/job/128366202631)
  reports that **Run reviewed Go workspace verifier**, **Verify root
  documentation governance** and **Verify notification delivery documentation**
  actually completed successfully on that source head. Linux and Windows
  [build scope](https://github.com/Negentropy-Laby/OpenSlack/actions/runs/42360008172)
  and [Self Validate](https://github.com/Negentropy-Laby/OpenSlack/actions/runs/42360008238)
  are earlier-delivery evidence, not CI for this new documentation candidate.
- #411 remains open/claimed, #428 open/blocked, #432/#433/#438 open/blocked,
  and #427 closed/blocked. #415 remains open/done. These are observed GitHub
  projections, not fabricated execution states. Existing reconciliation
  statuses remain unchanged; no Issue was closed, reopened or relabeled.
- The latest [#411 heartbeat](https://github.com/Negentropy-Laby/OpenSlack/issues/411#issuecomment-6602529066)
  still expired at `2026-11-03T13:23:46.973Z`; the ref still points to
  `b8b11ed64238c3b622d110e5d2d11944a342609e`. Neither an existing ref nor a
  claimed label establishes a fresh lease. No renewal or deletion occurred.

Only the obsolete #428 document-delivery/human-GitHub-review blocker is
removed. The R6 four-input digest table above remains exact and unchanged;
ADR-0005 remains **Proposed**, its Acceptance Record **Pending**. GitHub
approval and merge do not accept those exact bytes. C1–C7 implementation stays
blocked on the named decision authority, not on #411 or Cleanup qualification.

### #411 send-contract gap table

Supported redacted runtime doctors were executed against the primary checkout's
existing configuration using the independently installed, same-source CLI.
The first attempts could not start because that checkout's local dependency
tree could not resolve `@openslack/core`. That environment failure is retained;
it was not classified as an absent provider. After the isolated frozen install
and build, the actual diagnostics returned Aby **PASS / ready**, configured via
`.openslack.local/agent-runtime.json`, and direct OpenAI-compatible **FAIL /
not_configured**. No configuration was changed and no model request was made.

| Required property | Measured or source-bound evidence | Consequence if omitted | Owner and minimum next action |
| --- | --- | --- | --- |
| Existing runtime binding | Aby doctor confirms the local bridge, Bun 1.4.0 and bridge entrypoints; it does not attest the upstream vendor/model. Direct OpenAI-compatible configuration is absent in this checkout. | A bridge label cannot identify the actual serialization, counting or server output-limit contract. | Existing binding administrator supplies the approved non-secret upstream/model/protocol binding through its supported configuration; the agent inspects it without changing suppliers or sending a prompt. |
| Hard input-plus-output bound | `packages/workflows/src/internal/workflow-send-admission.ts` at `befa9392`: `totalConstraint()` unconditionally denies `SEND_TOTAL_TOKEN_UNVERIFIED`. An output-only cap is insufficient. | A real attempt could exceed 8,192 tokens including hidden/reasoning usage. | Sending-constraint maintainer verifies the actual provider contract, full serialized input bound, server-enforced output/reasoning limit and retry behavior; add regression-first code only after that proof. Unknown bindings continue to deny. |
| Current principal and lease | GitHub still exposes the expired November 3 heartbeat/ref. A fresh production principal/permission resolution and formal claim recovery have not been executed in this maintenance scope. | No current qualification ownership or actual provider/run binding is proven. | Qualification executor follows the supported identity and claim-recovery path after admission prerequisites; no copied identity, ad-hoc ref removal or borrowed Aby principal. |
| Campaign budget and original history | This preflight created no campaign, reserve or attempt and consumed no provider budget. Historical attempt journals were not opened or reset. | A new directory could otherwise hide prior attempts or unknown settlements. | Qualification executor reconciles the existing journal and Go reserve/settle before admission; preserve at most 4 attempts, 8,192 input-plus-output each and 32,768 total. Remaining allowance is not asserted here. |
| Frozen execution and approvals | The fixture and refusal boundary exist in merged source; no sealed execution candidate, live run, Workflow Trust decision or effect approval was established by this maintenance. | Local/CI evidence could be mistaken for authenticated resume, effect or drain qualification. | After the narrow provider fix is reviewed and merged, freeze source/bundle/allowlist/images and obtain the separate human decisions; the agent then runs the prescribed restart/resume and real 600-second sampling matrix. |

The Aby bridge's upstream provider remains **UNVERIFIED**, not “all providers
are unconfigured.” No provider-specific fix can be selected from these doctor
results alone. Batch 2 is BLOCKED on that missing contract proof; batch 4 is
NOT_RUN. This does not block independent Cleanup work or accepted Claim work.

### Cleanup admission gap table

The public GitHub metadata readback identifies
`Negentropy-Laby/openslack-cleanup-qualification-public`, ID `1381124543`,
`private: false`, default `main`, `delete_branch_on_merge: false`. This ordinary
repository query does not verify the deletion App's installation, token scope,
ruleset visibility or permission to delete. No actual deletion, Permit
consumption, installation or activation was attempted.

| Required property | Measured or source-bound evidence | Consequence if omitted | Owner and minimum next action |
| --- | --- | --- | --- |
| Exact target and scoped registry | Current administration contract binds the public repository/ID. Pinned registry SHA-256 `33a9b46866fedd768cb859abfd36341159fc0f3a3e306462575f1f34af7e7ebc` still allows only the old private qualification repository. | The production authorizer must reject the public target; a general repository read cannot grant cleanup scope. | Independent administrator updates the exact public repository scope and regenerated contract pin through its configuration delivery, retaining denial of old `pr.cleanup_branch`; no executor self-grant. |
| Actual OS identities | WSL2 host `DESKTOP-2SJF7KU`: named accounts are UID/GID `24001/24002`; contract requires `44180/44181`, which were not found. The inspecting session is root with Docker-group membership. | Root reachability does not establish isolated executor identity; silently changing account numbers or the contract would invalidate the binding. | Administrator reconciles the chosen contract with real accounts through the reviewed identity process; the agent does not renumber/recreate accounts. |
| Installed artifacts and state | `/etc/openslack-cleanup` is `0750 root:24001`; `/usr/lib/openslack-cleanup` is `0755 root:root`; `/var/lib/openslack-cleanup` is `0700 24001:24001`. Broker binary, `/run/openslack-cleanup` and its socket are absent. Protected credential/state contents were not read. | There is no evidence of a runnable current installation or safe upgrade/backup history. | Administrator provides the actual installation/launch history and installs or upgrades the frozen artifact with reviewed backup steps. Preserve ledger, worker journal and consumed/unknown operations; do not infer “never started” from a missing socket. |
| App, task view and independent isolation | Current deletion-App installation, target protection, full controlled task view and distinct-UID access denials were NOT_RUN. | An early invalid Permit/identity rejection cannot prove protection, dependency or credential isolation. | Administrator supplies the selected-repository App/configuration, protection and task view; the agent verifies each intended gate from an otherwise legal baseline under the independent UID. |
| Fresh activation and one-use targets | No current boot nonce or exact live Permit was obtained. Old private-target authorizations are not migrated or extended. | Reusing old activation could resurrect an old execution opportunity or repeat a side effect. | Administrator activates the actual new instance and issues exact target-specific one-use Permits; the agent runs preview, independent negatives, one deletion, original-receipt replay, absent readback and restart-only receipt query. Unknown results remain frozen for reconciliation. |

Only the affected installation/authorization/real-GitHub steps are BLOCKED.
No helper, wrapper, dashboard or broad Issue cleanup is a prerequisite to
completing this four-path documentation delivery.

### Independent tracks and bounded next work

Read-only release collision checks found no OpenSlack `v0.2.0` Release and a
404 for its exact tag ref. Public npm lookups returned 404 for version `0.2.0`
of `@openslack/plugin-api`, `@openslack/plugin-host`,
`@openslack/plugin-testkit` and `@openslack/sdk`. These observations are not a
reservation of a tag/version, publisher authorization, signature qualification
or permission to publish; collisions must be checked again at release freeze.
No release state or historical “not configured” label was promoted.

| Track | This round's result | Independent next condition |
| --- | --- | --- |
| Batch 1 / M1 | Four-path correction and two gap tables prepared; candidate validation and bot delivery are recorded separately, not inherited from #436. | Current-candidate documentation checks, independent review and new PR delivery. |
| Batch 2 / #411 constraint | BLOCKED; actual upstream/model/total-token contract is not proven. | Supported redacted binding evidence, then a bounded provider-specific change. |
| Batch 3 / Cleanup | BLOCKED at the explicit identity, scoped registry and installation gates above. | Reviewed administrator inputs; all actual tests remain the agent's responsibility. |
| Batch 4 / R-EXT | NOT_RUN; no calls, effects, attempt reset or 600-second sampling. | Batch 2 merged, fresh claim and frozen live candidate, independent approvals. |
| Batch 5 / C0–C7 | C0 document delivery/human GitHub review complete; exact R6 ADR acceptance BLOCKED. No C1 module, SQL, session, action or cutover is implemented here. | Exact retained Proposed inputs, decision authority/time/scope; then separate implementation deliveries in OpenSlack, with qualification/cutover limited to the public qualification repository and the primary task route unchanged. |
| Batch 6A | External qualification NOT_RUN. #372/#373 still require formal current-scope amendments; extra model calls have no budget. | Existing task-specific admission and external inputs; P2 plugin/Negentropy/Graph work does not block unrelated P1. |
| Batch 6B / 0.2.0 | Collision preflight only; nine gates, publisher inputs, canonical two-platform capstone and promotion remain unclosed. | Existing release runbook and role authority; no extra model budget is borrowed from #411. |

Issue comments/closing, an additional #415 assignment, C1–C3 timestamp-only
refreshes and wrapper enhancements remain P2/P3. They do not block M1 or any
unrelated qualified core track. Current code, local tests, hosted CI, distinct
UID isolation, live GitHub, live provider, human acceptance, merge and release
continue to be separate claims.

### Batch-1 local validation and preserved diagnostic failure

Validation used the isolated four-path candidate on parent `befa9392`, Linux
WSL2, Bun `1.4.0`, Node `24.18.1` and Go `1.26.5`. Counts below describe
separate executions, not a cumulative completion percentage. No implementation,
test, source-binding input or inventory declaration changed.

| Command or invariant | Measured result |
| --- | --- |
| `bun install --frozen-lockfile` | PASS; 351 installs across 411 packages checked without changes. `bun.lock` SHA-256 remains `c37b534a01955f7af0c85155186e7cd3c4fa99d8214ceed27175a187f3cc8db3`, equal to the parent blob. |
| `bun run typecheck`; `bun run build`; `bun run openslack workspace validate` | PASS; contract-family/source mirror checks included. |
| Documentation/send-admission/runtime-diagnostics regression | PASS, 96 tests in the three explicitly selected files. No live provider request or primary-checkout configuration write; fixture-local writes remain test setup. |
| Existing eight-file cleanup/transport/CLI regression | PASS, 245 tests, including real bare Git/two-clone expected-SHA rejection. This is not GitHub qualification. |
| Private executor/auth/client/digest composition | PASS, 88 tests; local FD/bare Git composition verifies one push, zero-push final rejection and no resend after an unknown result. |
| Cleanup Broker `go test -race ./...` and `go vet ./...` | PASS, 11 Go packages. Local tests do not prove the actual installed service or OS identity isolation. |
| `docs:generate`, `docs:verify`, `docs:migration-check`, `docs:notification-verify`, `openslack status verify`, `git diff --check` | PASS. Documentation verification covers 7 schemas, 167 active documents and 4 projections; C0 semantic execution remains NOT_RUN. Status is an exact inventory/projection match, not a new full-suite execution. |
| Scoped canonical invariants | PASS; 31 unique assignment IDs; six selected assignments only; all historical evidence retained; all execution/status fields unchanged; other control-plane authorities and #429–431 unchanged. |
| Source binding scan | Six tracked manifests/schema files scanned, 261 path/digest bindings; no changed path is bound, so no digest or source lock is rewritten. |
| Extra generated state views | Original SHA-256 values remain `68fc9d20a630027d4b79b8e3da06f7569c38a3e503f2f0748017753168a3575d` and `3808cc58412b63118f6af06cb8a1a7d1851a1fcd1f7367a80d06f39415ab64c9`; both retain Git mode `100644` and no diff. |
| Independent evidence/source review | ADEQUATE after the two wording corrections above. The final validation-only appendix receives its own readback; no previous-head CI is inherited. |
| This new candidate's hosted CI / human review / merge | Not established by these local results; tracked by the new bot delivery's exact head. |

The three regression scopes were each repeated once to retain machine reports
in `/var/tmp/openslack-six-batch-20261109.NFVVqa5m`, without accumulating the
repeated counts. These are the executed test selections, with the same report
directory expressed as a shell variable for readability:

```bash
OPENSLACK_BATCH_EVIDENCE=/var/tmp/openslack-six-batch-20261109.NFVVqa5m

bunx vitest run \
  scripts/documentation/__tests__/lib.test.ts \
  packages/workflows/src/__tests__/workflow-send-admission.test.ts \
  packages/agent-runtime/src/__tests__/openai-compatible-diagnostics.test.ts \
  --reporter=json --outputFile="$OPENSLACK_BATCH_EVIDENCE/docs-send-diagnostics.json"

bunx vitest run \
  packages/delivery/src/__tests__/git-transport.test.ts \
  packages/delivery/src/__tests__/branch-cleanup.test.ts \
  packages/pr/src/__tests__/cleanup-branch.test.ts \
  packages/pr/src/__tests__/task-link.test.ts \
  packages/github/src/__tests__/branch-evidence.test.ts \
  apps/cli/src/__tests__/pr-cleanup-branch-command.test.ts \
  packages/collaboration/src/__tests__/events.test.ts \
  packages/runtime/src/__tests__/propose.test.ts \
  --reporter=json --outputFile="$OPENSLACK_BATCH_EVIDENCE/cleanup-eight.json"

bunx vitest run \
  packages/pr/src/__tests__/cleanup-broker-executor.test.ts \
  packages/pr/src/__tests__/cleanup-executor-auth.test.ts \
  packages/pr/src/__tests__/cleanup-client-subprocess.test.ts \
  packages/pr/src/__tests__/cleanup-broker-digest.test.ts \
  --reporter=json --outputFile="$OPENSLACK_BATCH_EVIDENCE/executor-composition.json"
```

The Go command was `go version && go test -race ./... && go vet ./...`, run
in `services/cleanup-broker`. The retained `cleanup-broker-race-vet.log` is
explicitly a transcription of this turn's observed output, not a raw PTY log.
The source-binding check recursively inspected `{path, sha256}` objects from
`git ls-files '*source-manifest*.json'` and compared their paths with the four
changed paths. It establishes no changed binding input, not a fresh execution
of all service contract tests. Local reports remain outside the four-path Git
delivery and contain no credentials or raw provider responses.

An additional batch-6A preflight at `2026-11-09T14:44:16Z` invoked the supported
`github notifications qualification status` command against the primary
checkout using the same-source isolated CLI. It exited 1 with
`QUALIFICATION_ARTIFACT_INVALID`, not `QUALIFICATION_NOT_RUN` or PASS. The
canonical report directory/file is absent, while `.openslack.local/daemon`
and its `blobs` directory have mode `0777` on the Windows-mounted checkout.
The command constructs queue/blob/receipt stores before reading the report;
those constructors can initialize local directories and enforce secure storage.
The generic error therefore does not prove a corrupted qualification receipt,
and this invocation is not claimed as a strictly side-effect-free inspection
or proof that local storage was unchanged. No local state is removed, chmodded
or reset in response. No service admission, vendor delivery or qualification
seal was executed. The exact failing stage remains UNVERIFIED.

For #369, the existing append-only PR #308 PX2 receipt declares PASS only for
its historical audit; the current evidence index still records runtime
admission GATED, no passing sealed qualification report and IB7 NOT_AUTHORIZED.
The owner must establish a secure qualification state location, current gate
inputs and explicit qualification-only authorization before the agent executes
the real canary/vendor/reconciliation matrix. This local diagnostic failure is
retained independently of the successful documentation checks and does not
block the four-path delivery, Cleanup, or an otherwise admitted Claim track.

### First hosted candidate: dependency installation failure retained

Batch-1 delivery/readback for bot-authored Draft
[#439](https://github.com/Negentropy-Laby/OpenSlack/pull/439) completed at
`2026-11-09T14:52:58.140Z`; local commit, published branch and PR head all
matched `7aa87165066955a564351c33966c4e554e2de9fd`, tree
`a0fad276a5da5ad1159eed0d152f0cb806ee03b5`. Its direct parent is the verified
main `befa93921ec0fb83cfe1709f9ee3dd4de67d06df`, with no merge commits.

The [first canary job](https://github.com/Negentropy-Laby/OpenSlack/actions/runs/42639010891/job/129234765499)
failed in `bun install --frozen-lockfile` at `2026-11-09T14:53:11.9510118Z`:
the pinned `@octokit/auth-token@5.1.2` tarball at `registry.npmmirror.com`
returned HTTP 5xx. Build, golden evaluation and claim-flow classification did
not execute in that failed job. This is an observed hosted dependency-fetch
failure, not evidence of a failing application test or a completed CI gate.

A subsequent bounded read of that exact tarball returned HTTP 200, 6,081 bytes,
SHA-512 Base64
`JcQDsBdg49Yky2w2ld20IHAlwr8d/d8N6NiOXbtuoPCqzbsiJgF633mVUw3x4mo0H5ypataQIX7SFu3yy44Mpw==`,
equal to the unchanged frozen-lockfile integrity value. The artifact was hashed
without installation or execution. This limited recovery observation does not
guarantee availability from another runner and does not erase the original
failure. An independent single read at `2026-11-09T14:59:52.490Z` returned
HTTP 500, 78 bytes; recovery is not established. No dependency, lockfile,
workflow, assertion, skip or timeout changed.

The same clean `7aa87165` candidate separately reran the three explicit local
test scopes and Broker race/vet with `-count=1`, retaining `*-7aa87165.json`
and `cleanup-broker-race-vet-7aa87165.log` in the same external evidence
directory. Those executions remain bound to that commit. This appendix is an
evidence-only amendment to the same PR, not a second delivery or an extension
of its permissions; its new head's checks must be observed independently.

## 2026-11-10: #439 dependency-source repair

This is the explicitly authorized continuation of existing Draft
[#439](https://github.com/Negentropy-Laby/OpenSlack/pull/439), not a new PR,
Claim execution, qualification or release. The checked starting head is
`dda9779cc551a188efa29ab07eff3e7df95b4e75`, tree
`c98ff5c23c6e02f9bbc6e71011cc37988f5d8c7c`, on
`docs/batch-1-ledger-closeout-20261109`; its published history is retained.
The delegated maintenance scope is the three source/configuration files below,
this appendix, and formal inventory/projection outputs. It does not create a
new execution identity, claim, permission or provider budget. Independent
technical review is not human GitHub approval. No ADR is required for this
download-origin correction: no public interface, dependency selection,
authority, protocol or deployment decision changes.

`bunfig.toml` explicitly selects `https://registry.npmjs.org`. `bun.lock`
changes only the 311 previously verified tarball URL prefixes from
`https://registry.npmmirror.com/` to that official origin. All 418 package
entries retain their versions, dependencies, platform conditions and integrity
values. The 82 empty npm sources and 25 workspace entries are unchanged.
The exact complete lock text also equals the old text with only that prefix
substitution; no dependency resolver/update command was used. A separate
read-only audit rejects a version mutation and a well-formed but different
64-byte SHA-512 integrity value. These audit mutations are isolated values,
not writes to the repository lockfile.

The permanent regression in
`scripts/release/__tests__/workflow.test.ts` checks the parsed Bun default
registry, every explicit locked tarball origin and four single-condition
negative URL cases. It does not freeze dependency versions, hashes, package
counts or require an explicit URL where a future valid lock uses the default.
Configuration and frozen-install semantics follow the existing
[Bun registry contract](https://bun.com/docs/runtime/bunfig#installregistry)
and [frozen installation contract](https://bun.com/docs/pm/cli/install).

Evidence is retained outside Git in
`/var/tmp/openslack-439-registry-20261110.hpxzD7sV`:

| Observation | Actual result and scope |
| --- | --- |
| Official npm metadata | 311/311 exact package name, version, tarball path and integrity matches; `official-metadata.json`. Metadata agreement alone is not installation evidence. |
| Regression-first failure | `registry-red.json`: 11 PASS, 2 FAIL, zero skipped. The failures are the absent explicit default registry and the old mirror URLs. |
| Initial corrected regression | `registry-green.json`: 13 PASS, zero FAIL/skipped. Test source SHA-256 `71f1076a35982536182aacd37acb895a7e0fb8d16f19730604a7d7d983fb5e96`. |
| Reviewed regression | `registry-green-reviewed.json`: 13 PASS, zero FAIL/skipped, after removing an unnecessary explicit-URL count precondition. Test source SHA-256 `edcf21d5ed14ef049e75dc902f17dde4b7c633cfa267d7f99073b81288c1e249`; report SHA-256 `d80c4f4dce1465e031481a029c11bc4813b093a4ba09b63b84a15d2737376ddc`. |
| Independent source and QA review | ADEQUATE for the exact reviewed source bytes. Both reviewers independently read/hashed the inputs and reports; they did not independently rerun installation or inherit CI/qualification approval. |
| Cold staging setup | An initial archive/overlay sequencing error found no `package.json`; preserved in `cold-staging-first-failure.txt`. This was an invalid staging attempt, not a passing cold install or a dependency regression. The archive completed before the corrected overlay and install. |
| Valid cold install | PASS with Bun 1.4.0 in `/tmp/openslack-439-cold-20261110.mME2n1Ru`, archived from the starting head and overlaid with the three corrected files. The dedicated `/tmp/openslack-439-cache-20261110.0KqJDHAe` cache was empty before `bun install --frozen-lockfile --cache-dir /tmp/openslack-439-cache-20261110.0KqJDHAe`: 301 packages installed, exit 0. |
| Repeat frozen install | PASS, exit 0: 351 installs across 411 packages checked with no changes. Both installs retain the exact corrected lock SHA-256 below. The cold snapshot carries the initial corrected test source, not the later count-assertion removal; its package declarations, registry and lock bytes are identical to the reviewed installation inputs. |
| Typecheck/build/lint | PASS: `bun run typecheck`, `bun run build`, and ESLint for the changed test. Contract-family/source mirrors are included. Node's existing typeless-package warning remains a warning, not a changed dependency declaration. |
| Documentation/projections | PASS: `docs:verify`, `docs:migration-check`, `docs:notification-verify`, `openslack status verify`, `git diff --check`. The four roadmap/state projections remain byte-identical; the two extra T0 state views retain their original Git mode. |
| Formal inventory | `node scripts/verify-test-counts.mjs --update` generated 9,378 declared cases / 606 files, six additional cases. Only the root Vitest count in `.openslack/modules.yaml` and its generated `docs/status/current.md` count changed; module counts are unchanged. This is collection evidence, not a full-suite PASS count. |
| Harness compatibility | Fresh `prepare-compatibility.mjs` completed against clean original Harness `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`, with the corrected lock. Public-API typecheck and artifact emission passed without modifying original Harness files. Its ignored witness is SHA-256 `ed62ce180592be20deb71303ee4ee9ebcb1f29cfa6af718e80c1fa04343175cd`. This is local composition evidence, not live model qualification. |
| Final clean candidate / full suite / hosted CI | Pending at this appendix's freeze. Exact commit/tree, commands, outputs, actual checkout SHA and final reports will be published separately without another evidence-only commit loop. Prior-head CI is not inherited. |

Original lock SHA-256 is
`c37b534a01955f7af0c85155186e7cd3c4fa99d8214ceed27175a187f3cc8db3`;
corrected lock SHA-256 is
`a2609b4f8139750a3154189b1691567dbdd0544efbefcd0d6b15fe77964fe8f8`.
Corrected `bunfig.toml` SHA-256 is
`5ac5c7cfc74667729a0dddbbd885bca59d58925f176f730c3c1654bd15a27029`.
Local tools are Bun 1.4.0 and Node 24.18.1. No user-global registry, proxy or CA
configuration was modified. The six tracked source manifests are rechecked
against the final changed-path set before publication; only actual bound-input
changes could justify a digest update.

The regression commands name `scripts/release/__tests__/workflow.test.ts`
explicitly with `bunx vitest run --reporter=json --outputFile=<report>`.
The one-off audit uses the unchanged starting Git blob and the reviewed
working-tree bytes, not a resolver-generated second lock. Permanent regression
and candidate-specific provenance auditing have different purposes.

All previous hosted mirror failures above remain failures. This repair does
not assert Cleanup installation/GitHub qualification, #411 R-EXT, Claim v2
acceptance/implementation, human review, governance merge or publication.
No provider call, deletion, administrator configuration or automatic merge
was executed by this batch.

## 2026-11-10: #439 eleven-finding repair contract and historical erratum

This appendix records the authorized follow-up to the eleven-finding review
of `917db1f173fb94d647364f201caf05834afa1911`, tree
`970e8f94d9ade6bab991702b235602f79912f25c`. It continues the existing
`docs/batch-1-ledger-closeout-20261109` branch and
[#439](https://github.com/Negentropy-Laby/OpenSlack/pull/439), not a new PR.
The review disposition is **CHANGES_REQUIRED** until the repaired candidate
has its own verification and independent review. Previous source reviews,
installation results and hosted failures retain their original scope; they
are not inherited as approval or execution evidence for this follow-up.

The confirmed policy is official npm sources only for supported development
and CI installation, with no mirror fallback. The original `bun.lock` bytes
of this follow-up remain the reviewed official-source lock; dependency
versions, graph, integrity, Bun 1.4.0 and Node requirements are not changed.
The historical 311 explicit tarball URLs and 82 empty/default npm sources
describe that lock snapshot, not hard-coded acceptance counts for future
valid locks.

### Disposition of all eleven findings

| Finding | Priority and reviewed conclusion | Required repair or retained decision |
| --- | --- | --- |
| 1 — environment overrides | P1; existing byte-level assertions do not constrain effective registry settings. | Reject mirror environment overrides at the supported entrypoint and isolate installation configuration; empty npm sources must use the controlled official registry. |
| 2 — gate after installation | P1; a bad source can fail installation before Vitest runs. This is not a demonstrated successful merge bypass. | Run a named Node-only lock/environment check before dependency installation, without Bun, installed packages or network. |
| 3 — unrecognized lock structure | P1; the old scan can skip every unrecognized entry. | Validate supported `lockfileVersion`/`configVersion`, tables and tuple shapes; classify every entry, including valid workspace links and empty npm sources, without fixed URL counts. |
| 4 — duplicate keys | P1; TypeScript's last-wins parser accepts duplicate keys. A malicious earlier table being downloaded by Bun was not demonstrated. | Strict JSONC parsing rejects root, nested and escaped-equivalent duplicate keys while accepting supported comments and trailing commas. |
| 5 — scope registries | P1; default-only validation does not cover scope routing. | Validate every default/scope registry, including supported string/object URL forms, and isolate global configuration from the first Bun invocation. |
| 6 — official-only availability | Confirmed policy tradeoff, not a reason to restore a mirror. Explicit locked URLs also remain official even if the default registry is removed. | Document official npm reachability, standard proxies and explicit CA configuration; restricted mirror-only networks remain unsupported. |
| 7 — missing error context | P1; failures need a package and field locator. | Stable reason codes, package keys, field paths and sanitized origins; no raw URL, userinfo, query, fragment or credential-bearing exception output. |
| 8 — parser/output diagnosis | P1; raw JSON parsing/property access does not identify the violated invariant. | Distinguish process/executable failure, malformed output framing, configuration shape and source-policy rejection; installer calls remain zero on configuration failure. |
| 9 — unlocatable wording corrections | P1; the old acceptance sentence does not identify its conditions. | Retain the old sentence and append the exact two contrasts and recovery limitations below; obtain fresh independent review for the new candidate. |
| 10 — repeated positive control | P2; one source assertion executes in four parameterized rows, not four edit locations. | Use one standalone positive control and retain parameterized negative cases; no platform defect is inferred. |
| 11 — executable fixture convention | P2; consistency/diagnosis issue, not a reproduced naked-spawn platform failure. | Use the repository `testExecutable` fixture and the same normalized child environment in tests. |

P2 changes travel with their affected tests and do not block implementing the
P1 source gate. This is a scoped implementation of the already confirmed
official-source policy, with diagnostics and regression coverage; it changes
no product runtime/business API, permission, authority or persisted protocol.
No new ADR is required for that implementation choice. This does not waive
independent review or governance: the workflow wiring touches `.github/**`
and is **Red Zone**, requiring the applicable human GitHub review before
merge. No review, merge or release is established by this authoring appendix.

### Historical batch-1 review erratum for finding 9

The historical sentence at
[the original batch-1 verdict](https://github.com/Negentropy-Laby/OpenSlack/blob/7aa87165066955a564351c33966c4e554e2de9fd/production/qa/qa-ledger-dual-qualification-2026-11-03.md#L654),
`ADEQUATE after the two wording corrections above`, is retained unchanged.
The two conditions can now be identified as follows:

1. **Claim implementation location.** The reviewer's recovered message begins
   `初检：当前 diff 严格四路径` (pre-correction file-read output chunk `80df39`). The original
   wording was `then separate C1–C7 deliveries in the public qualification
   repository, not the main task route`. The corrected wording is `then
   separate implementation deliveries in OpenSlack, with qualification/cutover
   limited to the public qualification repository and the primary task route
   unchanged.` The corrected text is independently locatable in
   [the published batch-1 blob, line 625](https://github.com/Negentropy-Laby/OpenSlack/blob/7aa87165066955a564351c33966c4e554e2de9fd/production/qa/qa-ledger-dual-qualification-2026-11-03.md#L625).
   It distinguishes the implementation delivery repository from the limited
   qualification/cutover target; it does not start C1–C7 or migrate the main
   task route.
2. **Source rejection versus actual preflight.** The reviewer's recovered
   message begins `另一处建议精确化` (pre-correction file-read output chunk `815769`). The original
   evidence combined
   `source:befa93921ec0fb83cfe1709f9ee3dd4de67d06df:totalConstraint-unconditionally-denies-SEND_TOTAL_TOKEN_UNVERIFIED;no-provider-attempt-created`.
   The corrected evidence separates
   `source:befa93921ec0fb83cfe1709f9ee3dd4de67d06df:totalConstraint-unconditionally-denies-SEND_TOTAL_TOKEN_UNVERIFIED`
   from
   `this-preflight:runtime-doctors-only;no-campaign-reserve-or-provider-attempt-created`.
   Both corrected entries are in
   [the published control-plane blob, lines 1304–1305](https://github.com/Negentropy-Laby/OpenSlack/blob/7aa87165066955a564351c33966c4e554e2de9fd/memory_bank/control-plane.json#L1304).
   The source rejection is not a universal assertion of zero prior reservation
   writes: reservation can precede `totalConstraint` refusal. The zero-campaign
   observation belongs to that doctors-only preflight.

Both corrections were read back in the original tool chunk `ff26b4`; this
follow-up statically rechecked the corrected bytes in the exact published
`7aa87165066955a564351c33966c4e554e2de9fd` blob. The original reviewer supplied
the message recollections and before/after wording during this follow-up.
There is no separately persisted original review report or permanent message
ID for those conversation messages. Chunk labels aid local traceability but
are not immutable public evidence links, and the recalled pre-correction text
has no independently published original blob here. This appendix does not
retroactively manufacture such evidence or turn a present recollection into a
past published review. Fresh independent source/evidence review is required
for the final repaired candidate.

### Supported-entry guarantee and pending candidate evidence

The supported commands are
`node scripts/ci/install-dependencies.mjs --check` and
`node scripts/ci/install-dependencies.mjs`. The first is a read-only Node-only
lock/environment check without Bun, installed dependencies, network or
temporary writes. Default installation additionally validates configuration
using the fixed Bun parser under inert isolated bootstrap configuration,
then invokes a Bun 1.4.0 frozen official-source install. Only `--cache-dir`
and `--cafile` are optional installation arguments. A root `.npmrc` is rejected
by existence/type inspection without reading its contents.

Installation children do not inherit global registry/auth configuration or
dynamic runtime overrides. Parent-process publishing authentication remains
unchanged. Standard proxy variables are preserved; explicit `--cafile` is the
CA path, and legacy CA settings require named migration rather than silent
removal. Isolation lasts through child exit, with cleanup limited to the
specific private directory created by the entrypoint. This is not a host/PATH
sandbox, a restriction on arbitrary bare Bun commands, proof of a physical
network/CDN endpoint, or historical origin proof for existing cache entries.

| Evidence layer | Follow-up candidate status |
| --- | --- |
| Lock/configuration/diagnostic and early-failure regression | NOT_RUN at this appendix's authoring point; exact-candidate reports must identify commands, environment, exit codes and input hashes. |
| Isolated cold/repeat frozen install | NOT_RUN for this follow-up; prior-head install evidence above is historical, and cache hits alone do not prove download origin. |
| Full typecheck/build, applicable lint, formal inventory, source bindings and documentation checks | NOT_RUN for the completed follow-up candidate; maintainers update only genuinely affected canonical/generated inputs. |
| Full Vitest and compatibility witness | NOT_RUN for this follow-up candidate; no previous witness or overlapping test counts are promoted. |
| Independent source/security/evidence review | NOT_RUN for the completed follow-up candidate; this appendix is authored documentation, not independent acceptance. |
| Current-head Linux/Windows/macOS CI and actual checkout steps | NOT_RUN for the new candidate; verify Go verifier and downstream documentation steps actually execute. |
| Human GitHub review / PRMS / merge | NOT_RUN for the repaired candidate; governed delivery is through the same #439, with no automatic merge. |

Final reports belong in a separately retained candidate-bound evidence bundle
and the existing PR, not in repeated evidence-only commit loops. No provider
attempt, Cleanup deletion, administrator configuration, Claim implementation,
publication or release promotion is part of this follow-up. Other assignments,
qualification gates and release states remain unchanged.

### Review-11 implementation observations — 2026-11-10, before delivery

These observations concern the repaired source based on `917db1f1`, not its
old hosted PASS. The final commit/tree, actual CI checkout and complete command
records belong to the separately retained delivery bundle and the same PR.
The install entrypoint bytes are SHA-256
`903bd843ad87ace4409c690da949a19f451f440bf22e91d783c9b3953d4ebd18`.
`bun.lock` remains byte-identical to the published baseline, SHA-256
`a2609b4f8139750a3154189b1691567dbdd0544efbefcd0d6b15fe77964fe8f8`.

- **Measured RED:** the old source guard accepted three isolated bad locks
  (unknown format, missing tuple source, duplicate package table). Additional
  semantic/JSON-frame regressions produced seven failures before their repair;
  a missing-entrypoint collection failure is not counted as behavioral proof.
- **Measured related GREEN:** direct Vitest execution of the dependency-install,
  release-workflow and two affected Notification workflow tests passed
  **136/136** (98, 15, 15 and 8 respectively). URL negative controls preserve the
  legal tarball path and alter one relevant condition; parser/process/source
  reason codes have distinct assertions.
- **Measured installation:** an independent source snapshot with an absent cache
  completed a Bun 1.4.0 controlled frozen install and a subsequent frozen install.
  Both retained the lock bytes. The real no-network workspace fixture separately
  exercised malicious synthetic HOME/config/dotenv/dynamic environment inputs;
  it is not proof of all npm downloads or physical network origin.
- **Measured integrity:** full typecheck/build, applicable test-file ESLint
  (zero errors, one explicit-any warning), `node --check`, formal inventory,
  deterministic status/document generation and documentation verification passed.
  Inventory is **9,478 declared cases / 607 files**, not a passing-test count.
  All 261 path/hash bindings across six source-manifest files match their
  declared repository/service roots. Only the changed Notification workflow
  hash and its independent Go-test expected literal were rebound; binding sets
  and comparison logic are unchanged. Workflow Control contracts passed
  `GOWORK=off GOTOOLCHAIN=local go test -race ./tests/contracts -count=1`.
- **Measured compatibility:** the existing producer emitted a fresh Harness
  witness after rebuilding this checkout and the unmodified pinned original
  Harness dependency; no old witness was promoted.
- **Local full-suite FAIL retained:** direct full Vitest on WSL/root,
  Node 24.18.1, Bun 1.4.0, Git 2.34.1 and default Python 3.10.6 recorded
  **9,380 PASS / 73 FAIL / 25 skipped**. The affected source/CI tests passed.
  Seventy-one failed case names also failed at the old local baseline; the
  Python-dependent tests explicitly require Python 3.11+. Two additional
  asynchronous governance-shadow cases failed in the full run; a separate
  five-case diagnostic passed without source edits. That diagnostic does not
  erase the full-run failure or establish its cause. No timeout/assertion was
  relaxed. Hosted full-suite/platform evidence remains a separate requirement.
- **Independent review:** the non-author technical reviewer first required
  stricter npm identity/metadata/SRI classification, then independently verified
  those rejections and the unchanged real lock. Non-author source/QA review found
  the corrected negative controls, exact reason codes, fourteen pre-install
  entries and the two hash-only source-lock updates adequate. The documentation
  reviewer separately verified the historical erratum against `7aa87165`, with
  the original-message trace limitation retained. These are scoped reviews, not
  human GitHub approval, hosted CI, merge or qualification.

Current-head hosted checks, LIVE PRMS and valid human review remain pending at
this pre-delivery observation. The PR stays Draft until required checks close;
there is no automatic merge or change to any external qualification/release gate.

## #439 Watch stale-lock test follow-up — 2026-11-10

The requesting human explicitly added the Watch lock-test narrow repair to the
same #439 after the review-11 delivery. This is separate from the eleven original
findings, not a renumbering or a new PR. The starting published head is
`e9623a69001737e9c756df83516f29e14b8a3d13`; its Windows release job failed
`WatchDeliveryQueueV2 > reclaims an old lock only after its same-host owner
process is gone` with `QUEUE_LOCK_TIMEOUT`. Its other required checks subsequently
passed, including the reviewed Go verifier and downstream documentation steps;
the tag-release job was intentionally skipped. None of that old-head evidence
is promoted to the repaired head's PASS.

### Necessary repair and unchanged boundary

The v2 success fixture inherited a 100ms acquisition budget but used real
`Date.now()` across actual lock reclamation/fsync operations. Its purpose is
successful safe reclamation, not an I/O latency qualification. The existing v1
test already separates those concerns with a locally advancing clock and an
independent deadline rejection test. This follow-up aligns the v2 fixture with
that existing pattern:

- The success case advances only `Date.now()` deterministically; actual files,
  fsync, PID liveness, nonce/inode checks and `getStats()` remain real. The old
  lock and the reclaim gate must both disappear.
- Two additional cases exhaust the unchanged budget at exactly **100ms** and
  at **101ms**. Both must return `QUEUE_LOCK_TIMEOUT` after reclaim cleanup;
  previously seeded durable queue bytes must remain unchanged.
- Every clock spy is restored in `finally`, with the original function identity
  checked afterward. The real live-owner rejection case is unchanged.

This is a **no-ADR** local test-fixture repair of an existing contract: no
production/runtime code, timeout, public API, schema, permission, dependency,
registry, provider budget or workflow is changed. The two declared cases are
registered only through the existing inventory/status generators. No new tool,
platform, artificial production fault hook or administrator grant is required.

### Measured local evidence and limits

A retained test-only probe delays each real `fsyncSync` call by 125ms. Applied
to the exact old test in an `e9623a69` source archive, it fails with
`QUEUE_LOCK_TIMEOUT` after four injected fsync calls. Applied to the repaired
test with the same probe, it passes after seven real fsync calls. The target
diagnostics select one case: the 20/22 other cases are unselected, not proof of
full-suite execution. The probe is outside the delivery tree and is not a CI
prerequisite. It establishes a reproducible mechanism, not a measurement of
the historical Windows job's fsync duration or proof of its sole cause.

Normal, non-injected regression execution passed **65/65** across queue v1,
queue v2, notification blob storage and real-process blob/storage races, with
zero failed/skipped cases. The production lock implementation remains
SHA-256 `5adbcf2bec418fdd740ff9dc010a3496e45cda75d5934edf05db06911ba337df`;
the repaired v2 test is SHA-256
`b03890606a78bd11bf1ea34eed8fab0d9de76149ef9f0f9bb06dd7fdfe299c06`.

Full typecheck/build and affected-file lint passed locally. The previous
`e9623a69` local full-suite FAIL, Windows failure, diagnostic rerun HTTP 403 and
published review-11 evidence remain history; they are neither overwritten nor
counted as this candidate's success. Final commit/tree, independent reviews,
affected/full regressions and native current-head CI are recorded in the
separate evidence directory `/var/tmp/openslack-439-watch-lock.F4VtaAQV` and the
existing PR. Current-head CI, human approval and merge remain unestablished
at this appendix's authoring point. No permission expansion, human-auth fallback,
real provider call, remote cleanup or merge is authorized by this repair.

## PR #441 scope-enabled Git and Watch repair — 2026-11-12

This appendix is an additive local repair record, not completion of #441,
#411, Cleanup qualification, Claim v2 or release. The original post-merge
Windows Effect Shadow failure remains a historical failure with its precise
cause unconfirmed. The previously recorded root full-suite result remains
9,427 passed / 31 failed / 25 skipped; selected later successes do not rewrite it.

### Authority and source boundary

At `2026-11-12T01:03:13.639+08:00`, production principal resolution read back
the administrator-applied registry SHA-256
`a961cf2308c1889f8196a42c45127d55c717dd12d80c26cd1da16af749fe63da`.
All 14 approved additional paths were allowed and the protected deny rules,
Yellow ceiling, run binding and approval/merge prohibitions were preserved.
Issue #440 (`TASK-2026-904630`) had the matching 26-path scope. The real claim
was renewed through the supported heartbeat path; this is legacy ownership
evidence, not Claim v2. The administrator's local registry change is retained
in the primary checkout and is **not** part of this repair delivery. The agent
did not edit, stage or publish its own registry or substitute another identity.

The only delivery remains Draft PR
[#441](https://github.com/Negentropy-Laby/OpenSlack/pull/441), on
`fix/workflow-qualification-closeout-20261111`. This work began at
`4eb9254dadc9730005c547acc29b4ac3ce5a93db`, tree
`6d31dcdef97e365a786a4214a39667380a37446b`; the additional working inputs are
identified independently in `/var/tmp/openslack-441-scope-enabled.REvHrYrW`.
The eventual delivery commit/tree and current-head checks are recorded outside
the frozen source in that evidence directory and the same PR, not inherited
from the old head. Other worktrees, stash and historical evidence are preserved.

### Necessary narrow repairs

- Git 2.34.1 rejects `worktree list --porcelain -z`. Discovery now proves the
  conventional primary and this exact linked registration with reciprocal
  `.git`, `gitdir` and `commondir` evidence instead of parsing ambiguous newline
  porcelain or traversing unrelated missing registrations. Stable-file bounds,
  command cancellation, local overrides and foreign-primary rejection remain.
  Filesystem traversal/return preserves case; comparison normalization does not
  alter returned Windows paths. Unprovable layouts keep their own local state.
- Watch replay comparison no longer treats a newly observed timestamp or newly
  generated persistence/deadline clock as a changed input. Stored original
  event, persistence time, deadline, attempts, availability, receipt, authority
  and recovery history are retained. Route, epoch, vendor, Blob, config and
  substantive event conflicts still reject. No queue shape, retry budget,
  timeout, lock or fsync policy was changed.
- The formal inventory generator records **9,492 declared cases in 607 files**,
  including the three earlier Effect Shadow additions and nine Git/Watch cases.
  The existing status generator produced its matching projection. Inventory is
  not an executed-test count. No count was hand-filled and no source-binding
  set was expanded.

Both changes are local repairs of existing membership/replay contracts, with
no new public authorization, durable protocol or authority. Independent static
security and QA reviews found and followed up Windows path case preservation,
a negative fixture that could stop too early at ENOENT, and missing replay
assertions after accepted receipts and governed recovery. The final four-file
review records contain complete input hashes; neither review ran tests or
conferred human approval, architectural acceptance or qualification.

### Measured evidence and outstanding layers

| Layer | Result and scope |
| --- | --- |
| First Git/Watch RED | 43 passed / 7 failed; original unsupported-Git and new replay failures retained. |
| Git/Watch GREEN-B | 50 passed, zero failed/skipped; real temporary Git and persistent queues. |
| Modern Git observation | Git 2.45.2 client file: 22 passed; Linux only, not Windows evidence. |
| Related final local subset | 91 passed, zero failed/skipped across client, both queues, v2 router and Effect Shadow; overlaps the 50 above and is not added to it. |
| Build/checks | Full typecheck/build preparation, affected-file lint, formal inventory verification, generated status verification and documentation checks passed locally. |
| Source bindings | Six tracked manifest/schema files, 261 recognized bindings, zero missing/drift and no changed bound input after applying the service-relative Notification base. The initial root-only probe is retained as an invalid diagnostic, not a source defect. |
| Nonroot complete suite A | 9,443 passed / 24 failed / 25 skipped on unchanged copied code and fresh formal Harness witness. Nineteen failures stopped on absent pnpm/cache/HOME prerequisites; five Go/shadow failures remained unconfirmed. |
| Nonroot complete suite B | After explicit tool/cache/account-environment preparation: 9,459 passed / 8 failed / 25 skipped, exit 1. All 31 historical root failing titles passed in both complete runs. This remains a complete-suite FAIL, not a waiver or qualification. |
| Native platforms/current-head CI | Not established for the additional candidate at this appendix's authoring point. |

The isolated setup preserves its missing nested MCP dependency, missing vendor
declaration and Go download timeout failures separately. Corrections copy only
installed dependencies/builds and locked verified module caches into the owned
test fixture; the original Harness source, checks and deployment eligibility are
unchanged. A missing witness cannot be bypassed. Run B adds the actual nobody
home spelling `/nonexistent`, a private npm cache and a real Harness-pinned pnpm
installation; no system home, global registry, proxy, CA or credential is changed.
Tests run as existing UID/GID 65534, not as the Broker qualification identity;
local nonroot execution does not establish installed UID isolation.

Run B's eight failures are retained individually: three SDK/composition cases
cannot read their expected logs and one Harness task deadline expires. Watch
daemon, Cleanup fixture, effect authorization and Go account-framing cases
serialize `STACK_TRACE_ERROR` near their time bounds; their precise failure
mechanisms remain unconfirmed. These are not all classified as
environment failures. The keyless SDK summaries report terminal-complete and
exit zero but absent expected durable logs; exit zero is not substituted for
those missing assertions. No source repair outside the approved path/task
intersection is attempted. Further diagnosis and current-head CI remain open;
there is no automatic repeat-until-green, timeout increase, skip or weakened
assertion. The exact test reports, commands, identity/toolchain, witness and
unchanged-code readbacks are retained externally. This appendix was added
after the copied-code executions and is not represented as an executed input.

Provider proof remains **BLOCKED**: the designated OpenCode Go endpoint/model
does not by itself prove complete input, cache/reasoning, enforced output and
gateway-attempt bounds. `SEND_TOTAL_TOKEN_UNVERIFIED` remains fail-closed and
no model request or budget reset occurred. Cleanup's administrator-reviewed
UID/public-repository/pin differences remain outstanding; none of the three
conditional administration-contract paths is changed. No installation,
activation, Permit consumption, real deletion, approval, merge or release is
claimed. These unresolved obligations keep the single PR Draft.

## 2026-11-12: scoped transport repair and remaining-failure diagnosis

This is an additive execution record for existing Draft #441, based on parent
`7b37d4c1a0a0e5be36caf2de5c50f431a7b60431`. It does not replace the failures
above, grant an identity or task scope, or claim the whole repair plan complete.
The eventual commit/tree and later platform/Hosted observations are indexed in
the external evidence directory, without repeatedly committing check results.

Evidence root: `/var/tmp/openslack-441-exec-f.0rXaaHQD`. The acting principal
remains `codex_runtime_source-repair`, run `RUN-20260919113827-kv682q`, task #440
(`TASK-2026-904630`). Production readback in `preflight.json` confirms the
administrator's existing registry digest
`a961cf2308c1889f8196a42c45127d55c717dd12d80c26cd1da16af749fe63da`, the three
runtime paths and inventory/status/ledger path intersection, protected denials,
and the formally renewed legacy claim. This is not Claim v2 evidence. The primary
checkout's administrator change is preserved outside this repair delivery.

### Narrow repair, not a Provider total-token authorization

The adapter now captures options, model, run ID and cancellation signal before
awaiting. Reservation, host veto, encoded request, credential, endpoint and
settlement retain the same launch binding. A retained mutable options object
cannot swap the opaque boundary after reservation or change the settlement port.
Controlled OpenAI-compatible requests carry optional, frozen internal transport
evidence and use `redirect: 'error'`; unchanged transports do not receive invented
defaults. This evidence describes local adapter retry behavior only, never
gateway/upstream physical attempts or a token-count guarantee. The post-admission
deadline check rejects before POST instead of starting a new one-millisecond
transport after the total deadline has already expired.

The reviewed source identities are raw SHA-256 and byte sizes:

| Input | Bytes | SHA-256 |
| --- | ---: | --- |
| `packages/agent-runtime/src/openai-compatible-runtime.ts` | 28399 | `c54156d3e5f0c331bd09cb49621090c73887c9b76ca763f542eeebb67d3221c1` |
| `packages/agent-runtime/src/internal/provider-send-admission.ts` | 1710 | `82fc9b754d5119f5cbca631c276e513ae184554e5db6ba077b46df48707759fd` |
| `packages/agent-runtime/src/__tests__/openai-compatible-runtime.test.ts` | 55951 | `8750fb8927ddb01f0c605d8bbf510fc2590ecdb5fccbb6bd0882b9f792341655` |

| Layer | Observed result and limitation |
| --- | --- |
| Final-test baseline RED | The final 40-case test file on the unchanged parent implementation produced 29 passed / 11 failed. Exact baseline implementation and test digests are in `red-final-local.json`; no source rollback was performed in the repair worktree. |
| Focused GREEN | Runtime 40 passed and Workflow send-admission 18 passed, 0 failed/skipped. These 58 overlap earlier focused results and are not added to them. Five real loopback HTTP redirect cases verify one source POST and zero redirected requests. Veto, cancellation and expired-admission cases verify zero fetch calls. |
| Earlier deadline RED | `provider-deadline-red.json` preserves two real expired-admission failures and one incorrect test expectation for the cancellation error class. The latter was corrected to the exact original abort reason; it is not counted as a third production defect. |
| Repository checks | `checks-final-local.json`: typecheck, build, affected ESLint, formal inventory, documentation verify/migration/Notification verify, status verify, workspace validate, Cleanup Broker race tests and vet all exited 0. This local build/check execution as UID 0 is not nonroot isolation qualification. |
| Inventory and bindings | Formal producer updated and verified 9,502 declared cases / 607 files. Six manifest/schema files contain 261 recognized bindings, with no missing/drift/affected entries; no source-lock digest or binding set was changed. |
| Independent review | `provider-security-final.md` and `provider-qa-final.md` read the exact three source/test identities above; no blocking finding remained. They read producer results, did not independently rerun them, and confer no human approval or merge readiness. |
| Final complete suite/platform/Hosted | Pending at this appendix's authoring point. Parent-head CI has 11 successful checks and the normal skipped publish job; it is historical evidence for the parent, not for the additional repair. |

The check receipt above binds the five code/inventory/status inputs and predates
this additive appendix. Final appendix documentation verification is recorded
separately in `docs-after-append-final-local.json`; it is not inferred from those
earlier checks or from the unchanged runtime source hashes.

The total-token guard still returns `SEND_TOTAL_TOKEN_UNVERIFIED`. Official
model availability and a generated-token ceiling do not prove the frozen
OpenCode gateway's complete input, cache/reasoning, transformation and retry
bounds. No supplied secret was used or persisted; all model responses in these
tests are synthetic or loopback fixtures. No live campaign, provider attempt,
budget refund/reset or supplier/endpoint fallback occurred.

### Local Harness prerequisites and unresolved failures

The first unchanged seven-file diagnostic produced 254 passed / 4 failed /
1 skipped. Three SDK/MCP failures repeated the missing-log condition. The
retained test-copy script had omitted `native/system` runtime artifacts and
resolution links from the otherwise built original Harness. The JSONL plugin
therefore could not import its file-lock dependency; optional persistence did
not stop keyless SDK completion. Independent log assertions correctly failed.

The isolated copy was repaired with the exact original native outputs and
relative links, not changes to Harness source or the tests. The complete copy
inventory and checksums are in `harness-native-closure.json`; native import and
formal witness preparation exited 0 as UID/GID 65534. Original Harness remains
unchanged at `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`. A first root Git probe
was correctly rejected for dubious ownership before copying; the corrected
probe ran as the clone owner, without changing global Git configuration.

After that prerequisite correction, the same seven unmodified test files
produced 257 passed / 1 failed / 1 skipped (`remaining-eight-closure-b.json`).
All three durable Session cases passed. This subset is not a complete-suite
PASS and does not erase the eight-failure full run. The current witness does
not enumerate the native subtree; its separate artifact closure is retained
rather than claiming the witness alone detected or covered the omission.

The remaining subset failure is the real Go account-framing case. Verbose
output confirms its original 30-second test-budget expiry; separate unchanged
builds took approximately 30.7 seconds and 30.4 seconds. Installed Vitest's
timeout stack replacement explains the generic `STACK_TRACE_ERROR` marker,
but does not by itself identify every historical slow phase. Static review
also finds build/startup cleanup outside `finally` and kill without observed
closure. No test deadline or Go/VCS check was relaxed. That test file is outside
the current task scope and has not been edited.

The 100-request Harness case passes this subset, but static review confirms
duplicate admission performs an unnecessary temporary write/fsync before reading
the existing route. Its contribution to the earlier full-run deadline failure
is not independently established. A safe strict-read fast path and deterministic
zero-write replay regression remain proposed, not implemented; its implementation
path is outside the current principal/task intersection. Watch, Cleanup fixture
and effect-expiry cases passed this subset, not a replacement full-load proof.

### Still blocked; no completion promotion

- A minimum further repair scope can reuse the already allowed state-repair test
  for Harness regression: only `packages/agent-runtime/src/harness-admission.ts`
  needs new principal and task coverage; the Go framing test needs task coverage.
  An authorized scope owner must make that exact amendment. `task.sync` proposes
  a PR and is not evidence of Issue-definition-edit authority. No self-grant,
  Issue body edit or new action was used to bypass this gap.
- Provider total-bound proof remains missing; production admission stays denied.
- Cleanup still needs administrator-accepted existing UID 24001/24002 mapping
  against contract 44180/44181, public-repository registry scope and a reviewed
  new pin. The unchanged current pin correctly binds the old private-only
  registry; reading it does not approve a replacement. The existing never-started
  backup route is not used on started or unknown-history state.
- Final nonroot complete execution, native platforms, new-head Hosted checks,
  current-candidate review, valid human approval and LIVE PRMS remain separate.
  The PR stays Draft. No installation, activation, Permit, real deletion, Claim
  C1–C7, #411 external qualification, merge, release or production claim follows.

## 2026-11-12: recovered test lifecycle repair and bounded validation scope

This additive continuation starts at published PR #441 head
`b6bc44ca63e588e31cc648870d4f124678f04b4f`. It preserves the preceding failures,
the recovery package's original patch/index, the administrator's primary-checkout
changes and all other worktrees. The three recovered source snapshots match that
parent. The recovery package could not preserve two historical EIO-affected
artifacts; their absence remains recorded, not repaired by replacement evidence.

The execution record is
`.openslack/tasks/workflow-qualification-closeout-20261111.json`. Its evidence
directory is
`/mnt/d/Users/WSMAN/Desktop/Coding Task/openslack-441-execution-20261112.lyaifdb7`.
The existing principal and #440 claim were revalidated through production
authorization and the supported bot heartbeat. No identity or administrator
registry was copied into the isolated execution worktree.

The Operator fixture owns each test's gates, producers, observers, spy and roots.
Teardown releases gates, waits for producers, flushes observers, restores the
owned spy, then removes roots only after quiescence is established. Publisher
entry is observed before the hung-publisher assertion; cancellation cannot stand
in for that observation. Cleanup errors remain separate from a prior assertion
failure. Required-checks and staged-path refusal now prepare and clean their real
filesystem/Git fixtures in lifecycle hooks. Both malformed-rule rejection modes,
the zero-publication assertion, HEAD and existing staged contents remain checked.
No test timeout, worker count, skip or production guard was weakened.

| Layer | Observation and limit |
| --- | --- |
| Focused regression | `focused-tests-final.json` and its raw Vitest result: 55 passed, zero failed/skipped across the final three repaired files. This is not a full-suite result. |
| Go framing | `go-framing-preparation.json` records normal checksum-verified preparation with explicit writable GOPATH/GOCACHE/GOMODCACHE and unchanged module/source inputs. `go-framing-test.json` runs the original selected real Go handler/TypeScript two-read case under its original deadline. No Go framing source change was needed. |
| Affected static checks | `bootstrap-build-b.json` and `affected-lint.json` exit zero. The first typecheck failure is retained as `bootstrap-build.json`; the owned-spy function comparison was corrected before the successful build. |
| Declared inventory | Formal `verify-test-counts.mjs --update` collects 9,503 declared cases in 607 files, including platform-skipped declarations. The extra declaration separates the publisher failure variants; inventory is not a pass count. |
| Cleanup failure diagnostics | `fixture-lifecycle-diagnostic-result.json` exercises the verbatim final fixture function with controlled dependency failures and real temporary directories. All six scenarios pass: normal order, unentered-gate cancellation, flush failure, primary assertion plus flush failure, restoration failure, and observer creation failure. This diagnostic does not replace real integration execution. |
| Independent test review | `review-test-repairs.md` and additive `review-test-repairs-final.md` statically review the exact final source, including Operator SHA-256 `162768d743ce8ff7d1ce5f63c3d3ce30293e1643b2a775541ae58faa53e66ba0` and Runtime SHA-256 `1088a2513735aee7ac2ee35e42c7fef3da9935d85c37600416c470c4eb5e416b`; no remaining finding. The reviewer did not independently rerun tests or approve the whole PR. |
| Original Harness preparation | The network partial-clone failure is retained. A fresh private checkout at the required original commit was reconstructed from complete local Git objects without modifying the original Harness checkout. Its normal frozen install/build and the formal compatibility witness producer are required for complete execution. |
| Final candidate/platform/Hosted | Results are indexed externally against the actual commit/tree after this source change is frozen. Old-head checks and local focused passes are not inherited by the new candidate. |

The human-approved #440 amendment fixes the Wanmol endpoint and
`deepseek-v4.1-flash`, with a separate allowance of four generation attempts,
8,192 input-plus-output tokens per attempt and 32,768 aggregate tokens. This
does not consume or reset #411's history or budget. The supplied credential was
used only in protected transport memory for a non-generating model-list GET;
no value was retained in source or evidence. The endpoint advertises the exact
alias, but supplies no input-count, output/reasoning or hidden-retry bound in that
metadata. Public discovery responses are retained in
`gateway-public-discovery.json`. Generation POST count remains zero.

Independent Provider review is recorded in `review-provider-boundary.md`.
Serialized request identity, no local retry and a generated-output limit alone
cannot establish the gateway's complete physical consumption. Production
`SEND_TOTAL_TOKEN_UNVERIFIED` therefore remains in force. Obtaining vendor
documents is not imposed as an external prerequisite on the requester; the
unproven technical properties remain a concrete safety failure, not PASS.

The independently reviewed Cleanup draft is
`cleanup-administrator-proposed.patch`, with its exact ten-path follow-up scope
in `cleanup-administrator-handoff.md`. It retains the existing 24001/24002
accounts and public target, updates the canonical contract and registry pin, and
uses the existing generator. It has not been accepted or applied. Production
authorization denies the repair principal's registry/contract contribution;
no self-grant, registry write, account change, install, activation, Permit or
real deletion was performed. The current contracts and frozen historical
private-target fixtures retain their original identities.

PR #441 remains Draft while these mandatory Provider and administrator items
are incomplete. Current-head Hosted checks, complete candidate review, valid
human approval and LIVE PRMS remain separate delivery gates. No #411,
production, merge or release status is promoted by this continuation.
