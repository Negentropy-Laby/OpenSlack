---
schema: openslack.document.v1
id: qa-ledger-dual-qualification-2026-11-03
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: qa
updated: 2026-11-07
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

### R6 local execution and evidence reconciliation

Final source/test validation used `0412996ddaf8d8c73c63c11a18d8d548cd070c8e`.
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
