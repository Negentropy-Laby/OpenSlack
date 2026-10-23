# Issue #415 recovery validation snapshot

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
  `.openslack/modules.yaml` and `docs/status/current.md` pass the live task path
  filter, but the verified agent principal denies them with `path_not_allowed`.
  They are outside the effective task/identity intersection. A separate
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
