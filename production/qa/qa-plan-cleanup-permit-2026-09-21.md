---
schema: openslack.document.v1
id: qa-cleanup-permit-2026-09-21
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: qa
updated: 2026-09-21
sources:
  - design/cdd/modules/pr-review-merge.md
  - services/cleanup-broker/README.md
  - docs/architecture/control-manifest.md
---

# QA Plan: Permit-only Cleanup Broker

Generated using `qa-plan` for the approved #418 A0–A4 feature, Go 1.26.5 and
TypeScript/Vitest. Formal story files are absent; the approved acceptance
criteria and PRMS CDD supply the scope. This is a test plan, not a PASS record.
All tests are agent-executed. Administrator provisioning and human review are
external responsibilities, not tests delegated to the requesting user.

## Classification and Automated Requirements

| Work group          | Type                   | Test location and required behavior                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 peer identity    | Auth/Permission        | `services/cleanup-broker/internal/peer/*_test.go`: actual Unix peer credentials, root/broker/unknown UID denial, exact runtime/run binding, copied mapping.                                                                                                                                                                                                                                                                                                     |
| A2 permit/source    | Auth/Permission + API  | `internal/permit/*_test.go`, `internal/source/*_test.go`: closed versioned records, duplicate/invalid Unicode rejection, precise targets, expiry/revocation/nonce; fixed repository ID, pinned ordinary Git blobs, source drift and symlink rejection.                                                                                                                                                                                                          |
| A2 reservation      | Workflow + Data        | `internal/ledger/*_test.go`: subprocess lock, one winner, same-operation receipt, conflicting request, consumed permit, reopen, partial write, file/directory fsync failure and malformed chain.                                                                                                                                                                                                                                                                |
| A3 client           | CLI + Integration      | `packages/pr/src/__tests__/cleanup-broker-client.test.ts`: real local IPC, strict bounded response, unsupported platform, timeout/unknown outcome, no credentials/retry/fallback. Existing CLI tests must remain green.                                                                                                                                                                                                                                         |
| A3 executor         | Workflow + Integration | `cleanup-broker-executor.test.ts`, delivery channel/transport tests and Go runner tests: strict bootstrap, private bounded pipes, fixed environment, zero push before acceptance, one conditional send, unknown result reconciled. Actual-bundle and installed qualification remain separate.                                                                                                                                                                   |
| B1 boot/config      | Ops/Deployment + Auth  | `internal/config/*_test.go`, `internal/lifecycle/*_test.go`: fixed FD-owned installation, hash/UID/mode/path rejection, single-instance lock before socket handling, new durable boot nonce, generation latch, clock/config-change admission poison. These fixture tests are not actual distinct-UID installation qualification.                                                                                                                                |
| B2 request/recovery | Workflow + Data        | `internal/protocol/*_test.go`, `internal/broker/*_test.go`: bounded closed JSON, subject/target request binding, status before governance lookup, idempotent concurrent requests, detached execution, one durable send marker, final source observation, uncertain outcome and restart refusal. Handler fixture tests use a test double; separate runner tests exercise actual subprocesses. Valid-prefix ledger rollback is not detectable by the chain alone. |
| B3 worker/recovery  | Workflow + Ops         | `internal/runner/*_test.go`, ledger worker-journal and cmd tests: durable process identity before bootstrap, process-group termination and wait, residual-group refusal, protocol corruption/timeout, unified shutdown before ledger unlock. Integration-tag tests run the real TS artifact and do not contact GitHub.                                                                                                                                          |

Existing real bare-Git/double-clone tests remain required; IPC mocks do not
replace them. Expected SHA comparison does not prove branch lifecycle identity
after same-name/same-SHA recreation. Source acquisition alone is not registry
authorization; component tests cannot prove the composed send gate.

## Qualification and Smoke

Use the complete [service acceptance matrix](../../services/cleanup-broker/README.md#qa-plan-and-evidence-classes).
Smoke must start a read-only broker, authenticate status, reject an unauthorized
request, activate the exact boot through governance, reserve/execute one exact
dedicated target, persist its receipt, and restart without replay. The composed
installed route is NOT_RUN until qualified; actual isolated execution additionally
requires the administrator-provisioned dedicated UID, repository and App.

Both native Linux/Windows run the existing TypeScript cleanup regressions and
new client contracts. Linux and WSL2 separately qualify the Broker. Native
Windows Broker support is not claimed. A root development process is not an
isolation test: use distinct UIDs to prove credentials, configuration, executable
and ledger cannot be read/replaced, and privileged deletion cannot be invoked.

Real GitHub cases use independent registered targets: merged preview,
unmerged/closed-unmerged/protected/open-dependency/SHA-drift/default-denied
refusals, valid one-use deletion, original receipt on repeat, and independent
read-only absent-ref observation. Unknown results freeze the operation; never
issue another permit to blindly repeat it. No usability study is required.

## Evidence and Definition of Done

Record source/candidate and actual executable hashes, platform/tool versions,
governance commit, exact repo/PR/ref/SHA, permit/reservation/operation, timestamps,
outcome, `attempted`, audit status, exit code and sanitized evidence links.
Classify every required case PASS/FAIL/BLOCKED/NOT_RUN without cumulative counts
or substituting fixtures for real qualification. Do not archive credentials.

Run related regressions, full typecheck/build, source locks/formal inventory/
documentation checks, Broker fault/isolation tests, current-head CI, then frozen
candidate GitHub qualification. Review fixes require affected checks again.
Completion additionally requires independent review, valid current-head human
GitHub approval and PRMS governance merge. Task Claim v2 and release remain
separate; no QA plan or earlier CI result marks them passed.

## Current Implementation Boundary

The foreground daemon now composes the fixed source reader and installed TS
runner. Missing or invalid execution prerequisites select status-only service,
not a permissive transport. The runner sends bootstrap only after recording its
owned group. Its final private transport wait triggers an independent, non-
sending PRMS resource preview, fresh governance and task-view checks, then a
durable send marker and one grant. Current installed qualification is still
unproven; ordinary component success does not prove this whole route.

Historical broker queries use the immutable OS subject mapping and original
request binding, without current Permit or GitHub availability. CLI queries
still need the retained local runtime/registry identity claims; inactive status
does not block them, but lost or replaced claims are reported as unavailable
rather than reconstructed by guessing. This recovery limitation remains open.

Timeout/shutdown must prove the owned process group has disappeared and the
child was waited for before the daemon releases its ledger. If that cannot be
proved, the stopped daemon retains the lock. Neither a longer HTTP shutdown nor
a successful command exit alone establishes process containment.

## B3 Review Findings and Retained Boundaries

Independent review found and corrected a duplicate registry parser omitting
repository checks, an execute-to-preview wire mismatch, task-view expiry after
transport preparation, and shutdown ordering that could close the ledger before
handler receipt settlement. Final resource preview was moved behind the sending
worker's preparation wait without adding a public authorization callback.

Actual-bundle probes distinguish invalid-registry zero-network rejection from
a valid synthetic registry reaching a loopback CONNECT-denying proxy. The proxy
never forwards to GitHub. Such evidence proves protocol/parser composition,
not successful resource checks or a real deletion. Simulated positive resource
fixtures must be identified separately from the fixed production artifact.

The installation manifest binds explicit runtime files and administrator network
configuration. Its minimum required entries do not automatically prove the
host's dynamic dependency closure. Distinct-UID installation, runtime dependency
inventory, current-head hosted checks, real GitHub qualification and human
approval remain required, not inferred from local root-owned fixtures.

## B3 Local Verification Record — 2026-09-21

Base commit: `5bf63a573352cc42c739e943a773d675749a9456`; implementation remains
in the existing dirty feature worktree. This record does not identify a new
published PR head. Host: WSL2 Linux `5.15.167.4-microsoft-standard-WSL2`, Node
`24.18.1`, Go `1.26.5`. The ordinary local test runner is Bun `1.4.0`; the two
clean artifact builds explicitly use CI-pinned Bun `1.3.11` instead.

| Evidence layer                                   | Result / limits                                                                                                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Explicit 16-file cleanup/CLI/workflow regression | PASS, 381 cases in one complete run; includes 4 Linux private-FD/real bare-Git fixture cases. Not added to prior subset counts.                                                                                                                  |
| Go module                                        | PASS, `GOWORK=off go test -race ./... -count=1` and `go vet ./...`; nine internal packages plus tested command package.                                                                                                                          |
| Final real TS bundle through Go runner           | PASS, `-race -tags=integration ./internal/runner`; invalid registry zero-network and valid synthetic registry reaching a non-forwarding loopback proxy. Not a successful live resource/delete test.                                              |
| Typecheck/build                                  | PASS, root typecheck including the new build script, root build and workspace validation.                                                                                                                                                        |
| Inventory/docs                                   | PASS, formal inventory 7,105 declared cases / 525 files; generated status and documentation checks. Inventory includes platform-skipped declarations and is not an executed-test total.                                                          |
| Installation / true GitHub qualification         | BLOCKED: no fixed Broker config, task view, installation manifest or socket in this environment; current UID is 0, not the required isolated Agent. Dedicated repository lookup also encountered a TLS timeout, so its availability is unproven. |
| Bot delivery / current-head CI                   | BLOCKED: `DELIVERY_AUTH_REQUIRED`; supported bot launcher reports `BOT_APP_CONFIG_MISSING` for safe private-key access. No token copied, credential created, human-auth fallback, push or PR mutation.                                           |
| Human review / PRMS merge                        | NOT_RUN for this unpublished candidate; no approval or merge claim.                                                                                                                                                                              |

Go runner through TS resource fixture and real bare Git also passed four
integration scenarios: preview/ref retained, one granted deletion, denied
grant/ref retained, and post-send unknown with exactly one push. These use the
real private FDs, process journal, PRMS and delivery code. Remote API evidence
and the fixed Git location are test-only substitutes, not live GitHub cases.
Worker journals contain paired startup/finish records with matching process and
request bindings, and no unfinished group after each scenario. The unknown
case specifically asserts `ABSENT_AFTER_ATTEMPT`, `attempted: true` and one push;
an arbitrary executor error cannot satisfy that assertion.

Clean build evidence lives in `/tmp/cleanup-two-clean-builds-viol1g/report.json`
and its two independent source/install/build directories. These are local,
temporary evidence paths, not published artifacts. The 2,825-entry build source
snapshot SHA-256 is
`36e7d361ee8cd9465d2d7d8a6e6214a75c456030adcb05d995c5c22d9783b5cb`;
lockfile SHA-256 is
`d5abd6899a4c44d9f12f73eea91a18e51817fa9595cb98ecfb51b79f9caad86a`.
Both artifacts are 1,838,192 bytes with SHA-256
`7df98267db2f19be9efaf62b940f9d9e80ab31de4c02ef8f7e59b29672878c76`.
The final Go probe used that exact artifact. Node 22 hosted execution and native
Windows checks remain separate pending evidence.

Retained failures and corrections:

- Same-directory repeat builds missed an Undici `__filename` absolute-path
  difference between clean checkouts. The first clean-build failure remains at
  `/tmp/cleanup-two-clean-builds-wzQQj5`; a stable logical filename now covers
  only error-stack metadata, not module/resource lookup.
- A late Octokit hook did not reliably pin request fetch; an early fixture
  produced a read-only 401 using synthetic credentials, not a real credential
  or delete request. Construction-time pinned fetch and a no-global-fetch
  regression now prevent that fallback.
- A fragmented oversized private frame hit the default test timeout under
  parallel load. The reader now uses bounded preallocation and linear scanning;
  the timeout was not extended and no assertion or case was skipped.
- The HTTP response deadline originally expired before the bounded handler
  budget. A real-connection deadline regression now covers the 75-second server
  write envelope; handler/Permit/push budgets remain unchanged. A caller's
  shorter deadline still requires same-operation status lookup, never retry.

Independent source review closed its reported registry, preview-wire,
task-view/final-resource, process-shutdown and transport-boundary findings.
This limited review does not stand in for the unperformed installed isolation,
current-head hosted CI, human review or governance merge.

## Bun 1.4.0 Toolchain Update — 2026-09-21

This supersedes the current build-tool selection, not the historical evidence
above. All 13 setup steps in 10 workflows and the scoped `bun-types` dependency
now pin 1.4.0. The pnpm package-manager declaration, Node requirement, action
SHAs and release permissions are unchanged. The lockfile changed only the
`bun-types` declaration and its resolved version/integrity relative to the
pre-upgrade working copy. No global `@types/bun` was introduced.

The new workflow regression first failed on 1.3.11, then passed after the
upgrade. The existing notification workflow expectation was also synchronized.
One bound workflow digest and its Go contract mirror were updated; all six
source manifests still verify 257 bindings without drift. Independent review
confirmed no weakened assertions, altered binding sets or unrelated lock churn.

Local results for this update:

- Upgrade-related cleanup, notification and release regressions: 25 files,
  456 passed and one existing platform-specific skip; not a cumulative count.
- Broker race/vet: 10 packages passed. The real production-bundle runner probe
  and the separate Go/TS/bare-Git fixture composition passed with the new bundle.
- Workflow-control contracts: `go test -race ./tests/contracts -count=1` passed.
- Typecheck/build, targeted lint/format, workspace, status, documentation and
  migration checks passed. Formal inventory is 7106 declared cases in 525
  files, not an execution total.
- Linux-x64 unsigned development packaging passed both directory and archive
  smoke; the signed-release verifier correctly rejected the unsigned artifact.
  This used `--allow-dirty` and is not a release candidate or publication.

Two independent clean source trees, independent frozen installations and
separate build processes produced identical 1,766,136-byte executor artifacts:
`b2802045d0040a84353afadd15a9b48b1457625d826d5cd297e0b1184129c5ab`.
Evidence: `/tmp/cleanup-two-clean-builds-5DEFaY/report.json`; source snapshot
`c2fa0519afe3954456e706ff65c5a9de1adba025776fd53b61d0c56ce37e6b47`;
lockfile `6f2e2376de820d104eccac8858e87b0697b3bb899f34ca6d5ae7b541b2a16dd6`.
Neither frozen installation changed its lockfile. The actual host used Bun
1.4.0 and Node 24.18.1 on WSL2. The earlier Bun 1.3.11 artifact is historical,
not the artifact to install for this updated candidate.

The first full Vitest run retained at `/tmp/openslack-bun14-vitest.log` reported
7095 passed, five failed and six skipped. One failure was the old notification
version expectation, now fixed. `NO_COLOR=1` caused the color test failure;
removing that inherited variable made its targeted run pass. Other failures
remain open, without source changes or weakened checks:

- Git 2.34.1 rejects `worktree list --porcelain -z`, breaking the linked-worktree
  local-state fixture.
- Two owner-lock ACL identity cases depend on a directory ctime change after
  child creation; an independent local filesystem probe observed unchanged
  timestamps. These tests and their implementation are unchanged by the upgrade.
- Go's VCS stamping encounters invalid parent `/tmp/.git` metadata. That
  metadata was not removed and stamping was not disabled to mask the failure.

The same three files under the old Bun 1.3.11 launcher reproduced four failures
and 69 passes. Vitest still runs under Node: this is a launcher comparison, not
a claim that the complete old dependency baseline was restored. Local full-suite
acceptance is therefore not claimed. Temporary logs are local evidence only.

Final full-suite rerun after the version fix, with inherited `NO_COLOR` removed:
522 files passed, two failed and one skipped; 7098 cases passed, two failed and
six skipped. The remaining failures are the linked-worktree Git-version case
and Go VCS stamping (`/tmp/openslack-bun14-vitest-final.log`). The ACL cases
passed this run, but their prior intermittent failures remain recorded above.

Delivery remains BLOCKED: the supported delivery doctor returned
`DELIVERY_AUTH_REQUIRED`, and a live PR lookup timed out at TLS. No current
remote head or hosted result is newly asserted. No commit, push, PR write,
credential change, actual remote deletion or release occurred. Native Windows,
hosted Node 22, installed isolation and real GitHub qualification remain
separate outstanding gates.

### Isolated Environment Follow-up

The authorized environment-only follow-up used
`/var/tmp/openslack-bun14-validation-D9UdX1`. Git 2.53.0 was built and installed
there; only validation subprocesses selected it through PATH. The system Git
remains 2.34.1 and `/tmp/.git` was not altered. The Git source archive digest
matched the official downloaded checksum list (not an independently verified
signature). Development packages were downloaded and extracted locally, not
installed into the host. An initial stale apt-index 404 and local linker failure
are retained in the local preparation evidence.

A 2,826-file copy of the unpublished candidate was verified byte-for-byte:
snapshot digest `6182f5e1de9a14db892244fbaf1913ccfd409e5324d9f9c52232ab8266ebf934`.
It received a local fixture-only Git commit for VCS stamping; this is not a
project delivery commit. Historical objects required by the import-contract
test were fetched from the existing local checkout, with no remote write.
The source worktree and validation copy had zero file-byte changes during the
test runs. Only this evidence appendix was added afterward.

- Frozen installation/build passed with Bun 1.4.0 and Node 24.18.1.
- The previously failing linked-worktree resolution and Go account-framing
  integration passed without disabling VCS stamping or changing assertions.
- Initial targeted run: 71 passed, two ACL timestamp cases failed.
- Initial full run: 7096 passed, four failed, six skipped. One failure was an
  incomplete fixture history, corrected by copying the required local Git
  objects; that contract then passed. Other failures were two ACL timestamp
  cases and plugin-manifest path-replacement detection.
- Final full run with history: 7098 passed, two failed, six skipped; 522 files
  passed, two failed, one skipped. Failures were the `ensure` ACL child-churn
  identity assertion and watch-delivery stale-lock recovery timeout. The latter
  fixture uses a 100 ms lock budget; its cause remains under investigation,
  rather than being declared harmless load noise.
- The other ACL case and plugin case passed the final run; their previous
  failures are not erased. Independent filesystem probes found unchanged
  directory ctime in 19/20 child-creation trials and identical inode/ctime/mtime
  in 30/30 unlink/recreate trials. The relevant source/tests are unchanged from
  the branch baseline. These observations demonstrate unreliable fixture
  assumptions here, not a completed security analysis of replacement detection.

Evidence: `snapshot.json`, `targeted.log`, `full.log`, `history-plugin.log`, and
`full-with-history.log` under the directory above. Full-suite acceptance remains
FAIL. No production code, timeout, skip or assertion was changed to obtain a
pass. Stabilizing the filesystem/race tests is a separate remaining task. No
project commit, push, PR update, system Git replacement or permission change
was performed in this environment-only stage.

### Test Stability Repair and Local Closure

Following the request to continue, three test-only repairs removed assumptions
that varied with filesystem timing and parallel test load:

- ACL child-churn fixtures inject a precise ctime transition through the
  existing test-side lstat interception, retaining real child creation,
  directory identity checks and both refreshed-identity assertions.
- The plugin path-replacement fixture renames and retains the original file
  before creating the replacement, preventing immediate inode reuse. The real
  loader must still reject with `PLUGIN_MANIFEST_FILE_CHANGED`.
- Successful stale-lock recovery uses a deterministic advancing test clock.
  The 100 ms acquisition budget is unchanged; a new test explicitly exhausts
  it and requires `QUEUE_LOCK_TIMEOUT` with zero persisted queue entries.

No related production implementation, public interface, timeout policy or skip
was changed. Independent review found no weakened safety assertion or production
fault-injection surface. The `test-flakiness` analysis informed these fixture
changes; no tests were quarantined or disabled.

The three files passed all 91 cases in 20 consecutive runs. The final full run
in `source-final` passed 7101 cases with six existing skips, across 524 passed
files and one existing skipped file (525 total). These are separate runs, not
an accumulated passing-test count. Earlier failures remain documented above.

Final code snapshot: 2826 files, SHA-256
`131d2a6e686e14f5013d36ca299083db605cb262949ba7a55cb5ce1801f15c2a`.
Both the original working copy and isolated copy matched this snapshot at the
end of testing, before this documentation-only evidence append. Evidence under
`/var/tmp/openslack-bun14-validation-D9UdX1`: `snapshot-final.json`,
`stability-repeat-1.log` through `stability-repeat-20.log`,
`stability-typecheck.log`, `final-setup.log` and `full-stabilized.log`.

Typecheck, targeted lint, build, documentation/status verification and all 257
bindings in six source manifests passed. The formal inventory was regenerated
to 7107 declared cases in 525 files. This closes the local full-suite failure
gate for this snapshot; native Windows/hosted Node 22, bot delivery, installed
isolation, real GitHub qualification, human review and merge are still distinct
outstanding gates. No project delivery commit, push or PR mutation was made.

Rebuilding the executor from `source-final` produced the same 1,766,136-byte
artifact hash `b2802045d0040a84353afadd15a9b48b1457625d826d5cd297e0b1184129c5ab`;
see `stabilized-build.log`. These test-only fixes did not change executor bytes.

### Windows Bot Delivery Channel — 2026-09-22

The administrator-confirmed existing PEM input was used only through the
supported Windows wrapper, with an explicit path. No key was copied to WSL or
printed. A separate clean Windows delivery checkout was created at
`C:\Users\WSMAN\AppData\Local\Temp\openslack-418-delivery-12afd3fdfe5b457595e222d69e6494b6`,
on `prms/pr-cleanup-branch` at the existing PR head. The original dirty Linux
worktree and main checkout remained untouched by this probe.

Doctor returned `READY_FOR_PROBE`, seven accessible repositories, and contents,
pull_requests and workflows permission PASS. The authorized write probe then
returned `PROBE_CLEANED` at `2026-09-21T17:57:50.469Z`: temporary ref
`openslack/probes/write-1a82f4a3-0054-43e8-ad99-36970fd00300` pointed to
`5bf63a573352cc42c739e943a773d675749a9456` and was removed with readback PASS.
This is delivery-channel qualification, not Permit-only cleanup qualification.

Live PR lookup confirmed #418 OPEN/Draft with bot author, that same head and
`REVIEW_REQUIRED`. The ordinary gh query timed out; process-local
`GODEBUG=http2client=0` allowed the read to complete without weakening TLS.
PRMS doctor independently aborted its evidence request; no merge readiness is
claimed. Later current-head CI and real qualification remain required.

### CI Workspace Registration Repair — 2026-09-22

PR head `012917c059c674fa187361f646180cfdb7a0315b` completed with eight
successful checks, one failed check and the expected skipped tag publication.
The [failed Linux job](https://github.com/Negentropy-Laby/OpenSlack/actions/runs/35637185077/job/106457359074)
checked out that exact head. Its `Run reviewed Go workspace verifier` step
failed with `go.work must list every and only repository service module`.
Local `bash scripts/go-check.sh --all` reproduced that exact error.

The new cleanup Broker module had not been registered in the root workspace.
The repair adds its workspace entry, reviewed `pure/none/none` capability
configuration, and an empty module-local `go.sum` for its standard-library-only
dependency set. This profile invokes the common tidy/build/vet/race gates;
it does not qualify deployment or imply that the Broker has no I/O. Existing
separate executor integration and isolation requirements remain unchanged.

The workspace regression now compares actual service modules to workspace
entries in both directions and requires each service's sum and gate config.
The new expectation failed before registration and passes after the repair.
Its two source-digest bindings were updated without changing gate assertions
or the binding set. No new test cases were declared; inventory counts remain
unchanged. Independent code/QA review found no blocking issue.

Validation used the independent checkout
`/var/tmp/openslack-418-go-workspace-validation-20260922`, with a local-only
fixture commit `b8710858` containing the repair so `git archive HEAD` included
the actual candidate changes. This is not a delivery commit.

- The fixed Go 1.26.5 image (`sha256:3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647`)
  passed `scripts/go-check.sh services/cleanup-broker`: tidy preserved the
  empty sum; build, vet and all ten default race-test packages passed.
- The same image passed Workflow Control `go test -race ./tests/contracts -count=1`.
- All 45 `go-check-script.test.ts` cases passed; typecheck, build, targeted ESLint,
  documentation, migration, notification documentation and workspace validation passed.
- All 257 bindings in six source-manifest JSON files match. Notification
  Delivery v2 paths were resolved relative to its service, not the root.
- Full five-service `--all` passed the Broker gate, then stopped downloading
  the Governance Control migration tool on a `proxy.golang.org` TLS handshake
  timeout. This is an environment/network blocker, not a full-suite PASS;
  the first result is retained in
  `/var/tmp/openslack-418-go-workspace-all-20260922.log`.

The prior-head release run `35637184930` confirms that the cleanup and blob
storage steps actually passed on both Linux and Windows. Linux also passed
the Broker and executor composition steps; Windows intentionally does not
run the Linux-only Broker. These are historical head-bound results and must
not be reused as passing CI for the repair commit. New-head CI, real isolated
GitHub qualification, human approval and governance merge remain separate gates.
