# Issue #415 recovered disposition ledger

Run: `RUN-20261023103014-415delivery`. Delivery base:
`184adb088c6157ceec148061a6b8cef5f8444377`.
The 33-item map below was recovered from `RUN-20260919113827-kv682q`,
whose base was `06a680c69b0a7c38c003701ec4e7896bb45a2476`.
Original files and historical ledgers are unchanged; this is a new pre-publication
snapshot, not a rewrite of their historical results. Current evidence is in
validation.md. Live delivery state belongs to GitHub and the bot delivery receipt.
Original assertions are numbered in Issue #415 and the supplied 33-item review.
PATCHED means implementation exists, not full-task acceptance. PARTIAL/PENDING stay open.

| #   | Original assertion / reviewed conclusion                      | Disposition and evidence                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Snapshot byte self-comparison is redundant                    | PATCHED: manifest-only verification in identity resolution; workflow-identity tests.                                                                                                                                                                                                                                                                                                                           |
| 2   | Resume snapshot read is not a disk freshness check            | PATCHED: initial binding now compares a real disk read with loader evidence; confirmation performs a second disk read. CLI and client drift tests cover both roles.                                                                                                                                                                                                                                            |
| 3   | Missing snapshot must not be minted from unrelated disk bytes | PATCHED at CLI/TUI and resume entry; strict helper and missing-evidence tests.                                                                                                                                                                                                                                                                                                                                 |
| 4   | Repeated fallback selection disagrees                         | PATCHED / REVIEWED: loaded-module frontends require the shared strict helper; raw-byte client/descriptor constructors remain intentionally distinct and independently anchored. No universal missing-evidence fallback added. Identity/client/worker tests and architecture boundary documentation.                                                                                                            |
| 5   | Embedded builtin is misdiagnosed as source tampering          | PATCHED: missing loader evidence explicitly says embedded builtin unsupported; resume test. No hash bypass.                                                                                                                                                                                                                                                                                                    |
| 6   | Public resume signature accepts unverified modules            | PATCHED: opaque WorkflowResumeIdentity and runtime run-bound ownership checks; integrated tests reject unbound, copied and other-run handles and manifest mutation.                                                                                                                                                                                                                                            |
| 7   | Status gate exposes canResume with no identity check          | PATCHED: public ResumeEligibilityResult.eligible, no canResume/manifestMatch; resume test.                                                                                                                                                                                                                                                                                                                     |
| 8   | Current digest may carry wrong domain                         | PATCHED: resolve digest/domain/provenance together; unknown loaded hash is not labeled raw, function source has its own diagnostic domain.                                                                                                                                                                                                                                                                     |
| 9   | Stored domain disappears on mismatch                          | PATCHED: tagged mismatch retains recorded domain; untagged unmatched digest remains unknown; regression assertions cover both.                                                                                                                                                                                                                                                                                 |
| 10  | Confirmation drift omits compared identities                  | PATCHED: forward typed digest/domain evidence; CLI regression.                                                                                                                                                                                                                                                                                                                                                 |
| 11  | Historical double-domain matching is ambiguous                | PATCHED: strict optional persisted domain, Go new-write tag and domain-first matching; actual legacy raw/v2 recovery preserves file bytes; projection drift tests reject before writes. Not a proven bypass.                                                                                                                                                                                                   |
| 12  | Run audit producers disagree on identity source/domain        | PATCHED locally: v2 identity audit and v1 historical rendering; audit-run never loads current source; TUI uses merged same-head/base repository artifact gate and touches only its bound governance issue.                                                                                                                                                                                                     |
| 13  | Context ownership overstated as authentication                | DOCUMENTED: local canonical copy is not remote authentication; anchored digest and authority checks remain.                                                                                                                                                                                                                                                                                                    |
| 14  | Duplicate digest representations                              | PATCHED: result has one object per identity; guarded comparison resolves once; prepareResume retains complete diagnostic identities.                                                                                                                                                                                                                                                                           |
| 15  | CLI freshness protection described as global API enforcement  | DOCUMENTED: CLI reread, caller obligation, client ownership and worker checks separated.                                                                                                                                                                                                                                                                                                                       |
| 16  | Frontends lose typed drift reason                             | PATCHED: new-run client maps evidence to control INPUT_INVALID with typed cause; existing run maps recovery errors. Shared cause unwrapping preserves CLI/TUI reason, hashes and guidance. Loader invalid manifests use MANIFEST_INVALID; runtime/static divergence uses MANIFEST_DRIFT. Arbitrary import execution exceptions are not mislabeled as drift. Identity, loader, client, CLI and TUI regressions. |
| 17  | Second identity resolution escapes guarded path               | PATCHED in execute: one guarded matching call using execution manifest.                                                                                                                                                                                                                                                                                                                                        |
| 18  | Missing Go bytes become a Node argument error                 | PATCHED: typed control input error after route gate; Go/TS precedence regression.                                                                                                                                                                                                                                                                                                                              |
| 19  | Worker bind emits bare TypeError                              | PATCHED: worker source/manifest/bind errors use typed evidence; post-lease fatal passes the original error to bounded whitelist/hash-only stderr. Pre-lease failures retain frozen unsupported rejection. Worker drift/import/diagnostic tests pass locally; external process collection remains a separate qualification gate.                                                                                |
| 20  | Snapshot factory is public                                    | PATCHED: removed package-root factory export; internal constructor retained. Not an authentication guarantee.                                                                                                                                                                                                                                                                                                  |
| 21  | Execute resolves twice with different manifests               | PATCHED: one guarded match with explicit execution manifest; Go resume test.                                                                                                                                                                                                                                                                                                                                   |
| 22  | Move owned copies below async gates                           | NO CHANGE: unsafe suggestion; pre-await copies retained.                                                                                                                                                                                                                                                                                                                                                       |
| 23  | Worker hash results allegedly discarded                       | NO CHANGE: results participate in descriptor comparison; checks retained.                                                                                                                                                                                                                                                                                                                                      |
| 24  | File-loader fallback is unreachable                           | PATCHED: file loader return requires snapshot; worker fallback removed.                                                                                                                                                                                                                                                                                                                                        |
| 25  | Eager raw digest/source retention cost                        | NO CHANGE in this batch: loader consumes raw digest immediately; ownership retained.                                                                                                                                                                                                                                                                                                                           |
| 26  | Repeated boundary verification allegedly unnecessary          | NO CHANGE: independent client/descriptor/worker checks retained; only self-copy removed in #1.                                                                                                                                                                                                                                                                                                                 |
| 27  | Ambient snapshot allegedly unused                             | NO CHANGE: ambient callers consume evidence; retained.                                                                                                                                                                                                                                                                                                                                                         |
| 28  | Duplicate resume verification/translation                     | PATCHED: removed CLI duplicate comparison/translation, retained actual confirmation reread; client owns typed recovery mapping before any authority/descriptor write. Four real-client source/manifest negative scenarios and CLI forwarding/diagnostic regression.                                                                                                                                            |
| 29  | Resume binder repeats checks                                  | PATCHED: one binding verification mapped into recovery error, followed by independent route comparison.                                                                                                                                                                                                                                                                                                        |
| 30  | Repeated preflight reads                                      | PATCHED: createWorkflowResumePreflight owns store/run-bound closure observations, copies outputs and reuses reads before confirmation. Independent entry calls reobserve. Tests count reads and reject other-run identities; real preflight followed by completed authority fails client before mutations or descriptors.                                                                                      |
| 31  | Repeated route receipt setup                                  | PATCHED / CALIBRATED: unit/integration, CLI and historical client setup use shared receipt fixtures. The cited routing literal is an independent expected result, not setup; deliberately retained rather than computing expectations through the same helper.                                                                                                                                                 |
| 32  | Tests assert ownership rather than actual persisted artifact  | PATCHED: real client tests read the persisted descriptor and independently calculate domain-prefixed source/canonical manifest SHA-256. Journal-await caller buffer/manifest mutation retains original submission. Existing ownership and different-source snapshot tests retained.                                                                                                                            |
| 33  | Unrelated timeout tests in old PR                             | DECISION: no retroactive rollback; split unrelated changes in future delivery.                                                                                                                                                                                                                                                                                                                                 |

Independent first-batch code review found no source/authority weakening; it identified
profile-sync typed error presentation, now patched. Independent QA requested additional
entry, manifest-override, missing-byte and artifact tests. Full acceptance is NOT complete.

## Additional finding LIFECYCLE-1 (not part of original 33)

CLI/shared finalize lacked live merged-state verification. PATCHED: shared publisher
requires merged=true before all writes; governance requires complete evidence with matching
head/base and review head. Lookup failure, unmerged/closed-unmerged, drift or missing evidence
causes zero issue writes. Explicit CLI targets remain; TUI only touches its bound issue.
Dry-run carries an explicit preview marker. Lifecycle and TUI tests cover failures, target-only
success and preview. Independent review found the initial dry-run completion-message gap;
that gap and preflight status-copy timing were fixed and re-reviewed.

All 33 now have local implementation/documentation/no-change dispositions. This is not
hosted acceptance, external qualification, human approval or merge. See validation.md for
current-version test results and remaining environment/delivery gates.

## Recovery review findings — 2026-10-23

- RECOVERY-1 (P1, fixed): a real gate can return PASS with Governance issue=N/A
  and an arbitrary body reference. CLI and TUI now auto-select a governance
  target only when that criterion is PASS and the queried Issue/PR evidence
  matches. CLI rejects an explicit unbound governance override, retains explicit
  proposal/review/phase targets, and refuses missing reviewed head/base.
  Real-gate regressions reproduced the old automatic #999 target before the fix.
- RECOVERY-2 (P2, fixed): older local-first partial initialization can leave a
  running projection while accepted Go authority is still created. Missing-domain
  metadata is accepted only for the exact independently verified v2 anchor.
  Untagged raw and other digests, plus explicitly wrong domains, remain rejected.
  Real files prove successful authority transition and byte-preserved metadata.

Both independent reviewers rechecked the fixes and found no remaining P1/P2 in
their stated scopes. Their reviewed 35-file diff SHA-256 is
`e1b7a61f79dc936a632ecdd4ab0101684b92fc2bd42b5c4a36448bed71f10ea9`.
These are local read-only code reviews, not GitHub APPROVE, human acceptance,
container qualification, or permission to merge. All original NO CHANGE decisions
remain explicit; no Go protocol, SQL, frozen inventory, policy, registry, or #417
PostgreSQL gate rollback was introduced.

## Hosted diagnostic followup

RECOVERY-3 (fixed): the initial full hosted suite found that typed invalid-manifest
translation had removed the existing safe missing-meta hint. Restore that fixed
hint in the authorized loader implementation without raw exception/source text,
without importing invalid code, and without changing the excluded old test.
The expanded 28-file suite passed 581 cases. Both reviewers rechecked the fix;
current 35-file content/diff hashes and retained initial CI failures are recorded
in validation.md and run.json.

Scope clarification: the initial `filterByPath` probe checked forbidden paths
only. Explicit live `allowed_paths` membership also excludes the count/status
and old CLI fixture paths, while the principal independently denies them.
Corrected evidence is retained separately; a PASS from the forbidden-path filter
never granted write authority. Remaining fixture/count/timeout failures are real
delivery blockers for an appropriately authorized owner, not reasons to weaken
the lifecycle/source checks.


## PR #425 review repair: 32 candidates — local authorized subset

This section addresses the later 32-candidate report, not the earlier 33-item
Issue #415 list. Earlier results and failures above are preserved.

The local implementation commit is `f346cd5ea5a8813f2b955365258a6456531d3c19`. It has NOT been
published. The last observed remote/PR head remains `4327aa58`. All rows referencing
that local commit have Linux evidence only; current-head hosted Windows, macOS,
packaging and full acceptance remain NOT_RUN/BLOCKED. Independent agent review
is analysis, never human approval. No all-findings-closed claim is made.

| No. | Original candidate | Disposition | Handling and boundary | Regression/evidence | Local implementation |
| --- | --- | --- | --- | --- | --- |
| 1 | Embedded profile-sync cannot execute | CORRECTED ATTRIBUTION / PATCHED | Explicit SOURCE_KIND_UNSUPPORTED and accurate TUI/user guidance; file snapshots and sealed Go execution remain mandatory. | execution-client and TUI regressions | `f346cd5e` |
| 2 | TUI finalize with governance N/A | PATCHED / BOUNDARY RETAINED | PASS with N/A returns an explicit no-write result. No automatic proposal/review/phase selection; CLI keeps explicit targets. | real-gate TUI N/A and binding regressions | `f346cd5e` |
| 3 | Weak historical audit rejected | PATCHED | Persisted weak unknown identity uses explicitly legacy/unverified v1, same run ID; raw/v2/function-source diagnostic evidence remains v2. Never consult current source or grant execution. | audit RED 2 then GREEN; four-domain renderer matrix | `f346cd5e` |
| 4 | Unbound resume refuses | INTENTIONAL / DOCUMENTED | Keep opaque run-bound handles; document validated Go context -> bind -> prepare. Copy, forged and cross-run refusal remains. | formal binding and resume regressions | `f346cd5e` |
| 5 | Credential-free finalize preview unreachable | PATCHED | Shared early preview precedes live PR reads in both frontends; live reads are inside error handling. Preview never verifies merge or writes. | shared-preview and CLI/TUI zero-query tests | `f346cd5e` |
| 6 | Old CLI fixtures fail | BLOCKED_PRINCIPAL_SCOPE | The exact command-test path is task-authorized but principal-denied. Its gate/report/evidence fixtures and new preview mock must be migrated without weakening production. | full run: 4 failures in this file; no file modification | Pending authorization |
| 7 | Tests import stale ignored dist | BLOCKED_PRINCIPAL_SCOPE | Controlled Workflows internal subpath plus build-first root/CLI/Workflows test scripts require the pending package.json permissions. No weak alias or constructor re-export workaround. | direct Vitest ran only after explicit build; fresh-entry acceptance pending | Pending authorization |
| 8 | Count registry stale | BLOCKED_PRINCIPAL_SCOPE | Production collector measured 8188 declared cases against unchanged 8077. Modules/status updates remain denied. | test-count-drift-latest.log; no --update | Pending authorization |
| 9 | Finalize errors erase failure cause | PATCHED | Typed failure codes distinguish query/unmerged/evidence/drift/comment uncertainty and individual write stages; legacy errors[] retained. | lifecycle failure and zero-write tests | `f346cd5e` |
| 10 | Loader errors lose safe path/fields/cause | PATCHED | Bounded relative path and whitelisted field names retained with internal cause; frontend diagnostic never expands raw parser/source text. | loader and frontend RED->GREEN; sentinel tests | `f346cd5e` |
| 11 | Bind drift relabeled as loader mismatch | PATCHED | Preserve the source evidence reason and actual identity comparison on recovery errors. | SOURCE_DRIFT binding regression | `f346cd5e` |
| 12 | Unchanged digest described as hash mismatch | PATCHED | SOURCE_IDENTITY_DRIFT identifies stat/inode change with identical bytes; hash drift and manifest drift stay distinct. | real after-import file replacement RED 2->GREEN | `f346cd5e` |
| 13 | Missing metadata called weak legacy identity | PATCHED | Missing durable metadata is EVIDENCE_INVALID; historical classification uses persisted domain/provenance consistently. | missing-meta and persisted identity matrix | `f346cd5e` |
| 14 | Partial failure hides confirmed comment | PATCHED | Record each confirmed effect immediately. Lookup exact evidence-marked comments before posting again; unknown POST stops the batch for reconciliation. | partial labels failure, comment reuse, unknown-result zero-followup tests | `f346cd5e` |
| 15 | TUI optional Issue dereference | PATCHED | All binding reads use optional access; absent binding returns the domain refusal. | missing queried Issue TUI regression | `f346cd5e` |
| 16 | Number and parseInt disagree | PATCHED | One strict positive decimal safe-integer parse for PR and all Issue options; noncanonical values refuse before preview/live reads. | CLI input matrix and zero-query assertions | `f346cd5e` |
| 17 | Clone exceptions escape typed recovery | PATCHED | Guard capture/clone; reject Proxy, accessor, function and nonplain evidence without traversal side effects. | invalid-store evidence RED->GREEN | `f346cd5e` |
| 18 | Live base recheck rejects changed evidence | RETAINED / DIAGNOSED | Keep independent final head/base check. Drift produces PR_EVIDENCE_DRIFT and requires re-evaluation; never silently adopt another base. | live drift zero-write lifecycle test | `f346cd5e` |
| 19 | Redundant TUI PR lookup | PATCHED | Remove middle getPR; preserve report observation and publisher write-boundary live lookup. | TUI asserts no middle lookup; publisher recheck tests | `f346cd5e` |
| 20 | Repeated resume clones/comparison | PATCHED | Own observations once, clone only public results, and let CLI prepare once. Confirmation reread and final authority checks remain independent. | preflight ownership and CLI resume regressions; no timing claim | `f346cd5e` |
| 21 | Repeated worker drift hashes | PATCHED | Capture current source and manifest hashes once after import and reuse actual evidence. | worker drift and sealed bundle tests; no timing claim | `f346cd5e` |
| 22 | Governance binding duplicated in frontends | BLOCKED_PRINCIPAL_SCOPE | Add governanceRequired/verifiedGovernanceIssue to the PR gate only after its exact paths are authorized; current strict predicates remain. | PR gate/types/test paths denied; not rewritten through CLI | Pending authorization |
| 23 | Repeated diagnostic presentation | PATCHED | Use one bounded diagnostic/render helper with explicit per-frontend recovery guidance. | mutable-field/accessor/sentinel and frontend tests | `f346cd5e` |
| 24 | Identity/reason unions drift | PARTIAL / BLOCKED_PRINCIPAL_SCOPE | Worker consumes shared reason/domain lists and hash pattern; function-source audit rendering works. Core identity authority and package aliases require denied Core paths. | reason and diagnostic identity tests; Core work NOT_RUN | `f346cd5e` |
| 25 | Untyped persisted audit identity mapping | PATCHED | runMetaWorkflowIdentity owns classification for audit/resume. Untagged records remain unknown, not guessed raw. | three persisted-domain cases; unchanged input assertion | `f346cd5e` |
| 26 | manifestMatch duplicates canResume | COMPATIBILITY RETAINED | Keep the public field and derive it from the same comparison for identity-check results. Private state eligibility is not a verified resume result. | resume public API regressions | `f346cd5e` |
| 27 | Internal thin match wrapper | PATCHED | Internal consumer uses full comparison.matches and retains mismatch evidence; unused internal wrapper removed. | Go execution/identity tests | `f346cd5e` |
| 28 | Public snapshot-byte accessor | COMPATIBILITY RETAINED | Retain public accessor and owned-copy behavior; no public snapshot constructor restored. | snapshot copy/forgery tests | `f346cd5e` |
| 29 | Unused TUI root argument | PATCHED | Remove private executor argument and update handler wiring/tests. | TUI registry and executor tests | `f346cd5e` |
| 30 | Published commit subjects | HISTORICAL DISPOSITION | Preserve published history. New local subjects follow module-prefix rule. PR title correction remains part of authorized update-only publication. | published commits unchanged; no rebase/force-push | `f346cd5e` |
| 31 | Count rule violation (same as 8) | BLOCKED / SHARED | Same pending canonical count/projection reconciliation as #8; no duplicate finding count or hidden exemption. | production collector failure retained | Pending authorization |
| 32 | CLI business classifications | PARTIAL / BLOCKED_PRINCIPAL_SCOPE | Persisted identity classification moved to Workflows. PR gate decision projection remains pending the exact PR package permissions. | shared #22/#25 evidence | `f346cd5e` |

### Additional observed gates

- MCP-1: full Linux run reached a second legitimate blocked active-execution
  projection, `GOVERNED_MUTATION_EXECUTION_ACTIVE`, while its unchanged test
  accepts only `GOVERNED_PLAN_EXECUTION_ACTIVE`. The single-file rerun passed
  20/20; it does not close the aggregate failure. Read-only independent tracing
  and an in-memory invocation confirmed the alternate production projection.
  Minimal test-only repair must preserve exactly-one executor/completion and
  durable state assertions; both task and principal currently exclude
  `apps/mcp/src/__tests__/mutation-tools.test.ts`. No MCP code/test was edited.
- SCOPE-1: live Issue #415 includes the twelve requested paths, but the principal
  still excludes all twelve. The additional MCP path is absent from both layers.
  Static production parser/glob checks found no out-of-scope changed file; these
  checks are not a runtime permission snapshot.
- IDENTITY-1: `resolveAgentPrincipal` against the current product checkout reports
  no local runtime identity for this fixed agent. Known original worktree paths
  likewise did not contain it. Do not follow the generic bootstrap suggestion:
  a maintainer must identify or restore the existing approved identity/run. No
  identity, registry or credential was created, copied or changed. Remote
  publication and task synchronization are stopped until the binding is valid.

Required remaining repairs are not deferred as optional optimization. Pending
Core/PR/test-entry/fixture/count work, MCP regression correction, final full tests,
current-head hosted checks and PRMS still prevent task acceptance.
