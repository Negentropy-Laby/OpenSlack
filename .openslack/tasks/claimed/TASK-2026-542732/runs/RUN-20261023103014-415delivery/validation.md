# Issue #415 recovery validation snapshot

The initial sections describe candidate `6d68634e5970f3737a31b294b29b971f4c4a5377`.
The additive continuation at the end records the newer implementation and tests;
earlier PASS/FAIL results remain bound to their own candidate.

Date: 2026-10-23 UTC. Run: `RUN-20261023103014-415delivery`.
Base: `184adb088c6157ceec148061a6b8cef5f8444377` (fresh origin/main).
This is the pre-publication snapshot included in the candidate commit. Live GitHub
state and subsequent CI results must be read from the PR at its exact head.

## Candidate and preservation

The old 35-file content identity remains
`77685c2ce9b2112f01bc141086f706dc8f4c039a837aa74c84fde3748c4a2eb3`.
The old 3 ledgers and branch are unchanged. Reversible copies, original base blobs,
an indexed three-way patch, and a file-by-file manifest are retained at:

`/mnt/d/users/wsman/desktop/coding task/openslack-recovery/issue-415/RUN-20261023103014-415delivery`

Manifest SHA-256:
`01f5e9f95b7add05f85ab208d4d9e30317b9b737432f55e5d4178d42307d079d`.
All 38 original and copied files were independently rehashed with no mismatch.
No credentials, runtime identity, dependency tree, or unrelated worktree was copied,
cleaned, pruned, or rewritten. The Windows OS keychain remains authoritative; no
PEM fallback or credential/config change was used.

Current validated 35-file identity:
`b711a753c10fc8a9147d544b1ab1dae1a813d454401c2f4e461213a62e7a6189`.
Algorithm: sorted path + NUL + SHA256(bytes), LF-joined, then SHA256.
Reviewed implementation diff:
`e1b7a61f79dc936a632ecdd4ab0101684b92fc2bd42b5c4a36448bed71f10ea9`.
These hashes exclude the 3 new bookkeeping files to avoid a self-reference.

Migration used old base, preserved modifications and fresh main with Git three-way
application. Three conflicts were resolved: CLI resume-test imports, source manifest
pins and the matching independent Go expectations. Upstream CLI/type changes and
#417's PostgreSQL stop timeout fix remain. No Go wire protocol, SQL, frozen input
inventory, registry, policy, or protected workflow configuration changed.

## Current local results

Environment: WSL/Linux, Node 24.18.1, Bun 1.4.0, Go 1.26.5. Native Windows Bun 1.4.0
and Git were used only for the configured native keychain/bot delivery path.
The local Node version differs from hosted Linux/Windows Node 22.14.0; hosted
current-head qualification remains a separate gate.

| Check                                           | Actual result                                                                           | Raw log in recovery archive               |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| `bun install --frozen-lockfile`                 | PASS; unchanged lockfile                                                                | installation output recorded in execution |
| `bun run build`                                 | PASS, exit 0                                                                            | build-final.log                           |
| `bun run typecheck`                             | PASS, all script projects and exact-byte contract families, exit 0                      | typecheck.log                             |
| `bun run lint`                                  | PASS, exit 0; 2 unused-variable warnings, 0 errors                                      | lint.log                                  |
| Current focused Vitest suite                    | PASS, 27 files / 554 tests, 140.90 s, exit 0                                            | focused-regression.log                    |
| `bun run docs:verify`                           | PASS: 7 schemas, 161 active documents, 4 generated projections                          | docs-verify.log                           |
| `bun run docs:migration-check`                  | PASS: 103 manifest entries                                                              | docs-migration.log                        |
| `bun run openslack workspace validate`          | PASS                                                                                    | workspace.log                             |
| `GOWORK=off go test ./tests/contracts -count=1` | PASS from services/workflow-control                                                     | go-contracts.log                          |
| Independent source-byte recomputation           | PASS: all 229 bindings match; inventory/authority unchanged                             | command result and Go fixed expectations  |
| `git diff --check`                              | PASS                                                                                    | final index check before commit           |
| `node scripts/verify-test-counts.mjs`           | FAIL: 8,077 registered vs 8,149 collected declared cases; fixes outside principal scope | test-inventory.log / scope-gaps.json      |

The focused command is `bunx vitest run` with the following paths and
`--maxWorkers=2` (it does not invoke the package pretest worktree-prune hook):

- `apps/cli/src/__tests__/{tui-executors,workflow-resume-identity}.test.ts`
- `packages/github/src/__tests__/{workflow-issue-publisher,workflow-issues,workflow-lifecycle}.test.ts`
- `packages/workflows/src/__tests__/{execute-go-authority,loader,resume,run-store,workflow-identity,workflow-run-routing}.test.ts`
- `packages/workflows/src/__tests__/integration/resume.test.ts`
- `packages/workflows/src/__tests__/workflow-runner*.test.ts`

New regression RED evidence was retained, not overwritten: two failures in the
TUI/partial-initialization run and four failures in the CLI binding run. After the
fixes, the same three test files passed all 79 cases. The final expanded 554-test
run includes those cases; overlapping counts are not added together.

Coverage includes confirmation-time disk drift, caller mutation across await,
unbound/copied/cross-run opaque identity rejection, independent client/worker
checks, historical raw/v2 metadata bytes, partial initialization, audit after
current source deletion/change, persisted descriptor independent hashing, and
merged/head/base/governance negative finalization with zero Issue writes.
Historical 546-test evidence remains historical, not this candidate's evidence.
The full 8,149-case inventory was collected, not executed as a full-repository
test run. Module count drift is 1392→1406, 2091→2104, 2139→2153 and 4683→4742.

Two independent read-only reviews found one P1 and one P2, both reproduced, fixed
and re-reviewed. Neither review originated an APPROVE or changed the Git index,
refs or files. One reviewer initially ran `git write-tree`, potentially adding an
unreferenced tree object; this did not alter the index, refs, worktree or delivery.
Both final code reviews bind to the implementation diff hash above.

## Remaining gates and authorized stopping point

- Local Docker: BLOCKED; `/var/run/docker.sock` is absent. Docker configuration was
  not changed. Local Go contracts do not establish real PostgreSQL/container
  qualification.
- Hosted Linux/Windows: pending Draft publication. Existing exact-head jobs cover
  real PostgreSQL/restart, container/sealed-worker and native Windows boundaries.
  Check run head SHA, PR head SHA and remote branch SHA must be identical.
- Test-count registry drift is an actual failure. Both
  `.openslack/modules.yaml` and `docs/status/current.md` are absent from the live
  task's explicit `allowed_paths`, and the verified principal denies them with
  `path_not_allowed`. The first probe's `filterByPath` result only checked
  forbidden paths; it was not allowed-path authorization. The explicit corrected
  probe is preserved as `scope-gaps-explicit.json`. A separate
  appropriately authorized owner must reconcile counts and generated status;
  this run did not modify registry permissions, update those files, or weaken checks.
- Original external plan file is missing:
  `C:/Users/WSMAN/.claude/plans/23e6c168-pr-shimmering-meerkat.md`.
  It was not recreated from archived text.
- Human approval, merge and task acceptance are NOT complete. Publish one bot Draft
  PR targeting main, transition #415 to review with a verified PR association, keep
  the Issue open, and stop. No completeClaim, APPROVE, auto-merge, #411, GS10–GS13,
  production operation, provider call or release is authorized.

Rollback is an ordinary reviewed additive revert of the candidate's commit after
separate authorization; do not reset history, delete the original worktree or
alter the claim ref. Old and new evidence remain independently reviewable.

## Additive continuation after initial hosted CI — 2026-10-23

Initial candidate `6d68634e` reached real hosted execution. Its full root suite
reported 8,140 passed / 3 failed / 6 skipped. The loader missing-meta diagnostic
regression is fixed within the existing authorized implementation/test paths:
the error remains `WorkflowSourceEvidenceError / MANIFEST_INVALID`, is thrown
before dynamic import, and exposes only a fixed safe missing-export hint, never
source or the original exception. The excluded `claude-loader.test.ts` was not
edited; its existing assertion now passes.

Current 35-file content:
`f6998535ae0ca6c3d40b4e036a387fe9698fc9f35d9d86c813b3d08a3d45c9be`.
Current 35-file implementation diff relative to `184adb08`:
`9ac563a825d26a0e3e736ed0981c4f742990fd2d51effb52ea56dcdc1c976ec1`.
Both independent reviewers verified these hashes and all 229 source bindings;
no new P1/P2 was found in the followup. Lifecycle code is unchanged from the
previous reviewed candidate.

Fresh local results for this implementation:

- PASS: expanded suite, 28 files / 581 tests, 102.50 seconds, exit 0,
  `followup-focused.log`. Same original paths plus the read-only execution of
  existing `claude-loader.test.ts`; no test was moved or copied to avoid scope.
- RED then GREEN: loader pair had 2 diagnostic failures, then passed all 76 cases
  in `loader-diagnostic-{red,green}.log`. These overlap the 581-case suite.
- PASS: build, full typecheck, lint (same 2 warnings/0 errors), docs verification,
  workspace validation and all Go contracts; logs use the `followup-` prefix.
- Source lock: PASS, 229 bindings. One actual loader digest and the independent
  Go fixed expectation changed. Frozen inventories, SQL and protocols did not.

Remaining observed failures are not hidden:

1. The excluded `apps/cli/src/commands/__tests__/collaboration-workflow-issues.test.ts`
   has two stale fixtures: mocked PASS omits mandatory `criteria`, report omits
   queried `workflowGovernanceIssue`, and its positive exact assertion also omits
   `expectedHeadSha/expectedBaseSha`. Local execution reproduced 2 failed / 16
   passed. A read-only independent review confirmed fixture migration is needed;
   relaxing production evidence checks would reopen the repaired P1.
2. Initial Windows artifact tests additionally reported a suite-launch failure
   and two 5-second fixture timeouts in excluded bot/process/cleanup tests.
   Those files are unchanged. This is an observation, not proof of baseline
   failure or flakiness; no timeout/check was relaxed.
3. Count/status reconciliation is still excluded by both task and principal.
   The measured 8,149 inventory belongs to the initial candidate; this followup
   adds one declared case and requires its own hosted current-head result.
4. Initial Windows runtime qualification passed. Initial Linux Go/container
   qualification was still running at this snapshot. Neither result may be
   reused as qualification for the additive commit.

The original scope probe and logs are retained; corrected explicit allowed-path
and principal receipts are alongside them. The 38-file delivery set is unchanged.
This is an additive update to the same Draft PR #425, not a second PR or a history
rewrite. #415 stays open/review; no APPROVE, ready-state transition, merge,
completeClaim, automatic merge, #411, GS10–GS13, production operation or release.


## PR #425 32-candidate review repair — local subset, acceptance BLOCKED

The implementation commit is `f346cd5ea5a8813f2b955365258a6456531d3c19`,
locally appended to the existing #425 branch. The reviewed source diff against
`4327aa58` is SHA-256 `9c50e9807f64ba9e0bc94dc628375f0e4c4688e0b7dc5910597207912d1d78d7`.
No replacement PR, rebase, force-push, main edit, approval, merge or deployment
was performed. Remote publication is NOT_RUN, for the binding reasons below.

### Actual local checks

Logs are preserved in `/var/tmp/openslack-pr425-repair-evidence-20261023`.
Earlier RED logs are not replaced by the GREEN results. Their counts overlap and
are not added together. RED behavior included eight lifecycle/resume/loader
failures, two real worker file-replacement failures, two historical audit
failures, one frontend diagnostic failure and three presentation failures.

| Check | Observed result | Evidence |
| --- | --- | --- |
| Final affected suites | PASS, 11 files / 351 cases | focused-owned-copy-final.log |
| Full Linux Vitest, 4 workers | FAIL: 8171 passed / 5 failed / 6 skipped, 8182 cases | full-vitest-authorized.log |
| MCP isolated rerun | PASS 20/20; does not close full-run failure | mcp-failure-isolated.log |
| Build / full typecheck | PASS | build-final-authorized.log; typecheck-presentation-final.log |
| ESLint | 0 errors / 0 warnings | lint-latest-authorized.log |
| Workflow Control Go race / vet | PASS | workflow-control-race.log; workflow-control-vet.log |
| Independent source bytes | PASS, 229 bindings, only 14 actual existing source digests changed | source-lock-independent-final.json |
| Sealed runner independent bundle | PASS local byte/default-off checks, 3046811 bytes | sealed-runner-verify-local.log |
| Workspace / golden / Genesis | PASS / 7 of 7 / 5 of 5 | workspace-authorized.log; golden-authorized.log; genesis-authorized.log |
| Docs / migration / notification docs | PASS | docs-*-final.log |
| Status projection | PASS against unchanged old registry; not test-count reconciliation | status-verify-authorized.log |
| Production test collection | FAIL, 8077 registered / 8188 collected | test-count-drift-latest.log |
| New-head hosted CI / PRMS | NOT_RUN; local repair is not published | existing PR remains Draft |

The full run preceded six additional persisted/diagnostic identity compatibility
cases. Those six passed in the final 351-case focused run; the final full tree
has not passed. Four full-run failures require the exact command-test fixture
migration (including its new preview mock), still principal-denied. The fifth
full-run failure is the MCP active-blocker assertion explained in findings.md.
Its isolated PASS is retained separately and is not described as an aggregate fix.
No tests, assertions, workers or timeouts were relaxed to hide these failures.

The source manifest retains all inventory keys, paths and authority fields.
The Go source-lock test is an independent exact-byte expectation, updated only
for the same actual changed sources. The local Go invocation does not establish
real PostgreSQL/container integration: no daemon or production authority was
provisioned for this repair. The sealed bundle SHA-256 is
`41eae08d50f3d013a278f62ff27873000fe901d8a89226a46cd5ece7e80fdc94`;
it is a local code check, not an installation or execution grant.

A separate-context read-only agent reviewed the exact 30-file subset, checked
all 208 primary source hashes and Go expectations, and exercised boundary
projections in memory. It found no concrete remaining defect within that subset
after the sanitized diagnostic-field fix. It did not implement, approve or
validate the still-blocked Core/PR/test-entry/count changes. This is not an
independent human or hosted approval.

### Authorization and publication stop

Issue #415 was independently re-read: the requested twelve exact paths are now
in task scope. The actual principal registry still excludes all twelve; the
new MCP test-only path is excluded by task and principal. Static production
registry/task parser and glob checks found all changed paths within the original
intersection. This is explicitly **not** a live runtime authorization receipt.

The actual `resolveAgentPrincipal` call against the current checkout reports
missing fixed local runtime identity. Known original checkout paths also lack
it. No bootstrap, identity copy, new run ID, own registry edit or prompt edit was
performed. A maintainer must identify/restore the original approved binding and
apply its governed scope amendment before a fresh live permission snapshot and
remote task publication can be claimed.

The supported native bot heartbeat did verify the exact existing claim ref and
owner and extended it to `2026-10-23T17:45:42.439Z`. Earlier native-launch probes
failed before the wrapper ran; their empty/non-authoritative exit statuses were
not counted as heartbeat success. The final receipt is
`claim-heartbeat-direct-native.log`; credentials were neither printed nor read
by the repair worker. Lease continuity is not a substitute for runtime identity
or path authorization.

The 1-32 table in findings.md distinguishes fixes, corrected attributions,
compatibility decisions and blocked work. Task acceptance remains NOT_COMPLETE.
Next publication must be update-only for open Draft #425, verify head/ref/check
SHAs, retain all failures, and wait for final full checks and PRMS. Human approval
and merge remain outside this execution.
