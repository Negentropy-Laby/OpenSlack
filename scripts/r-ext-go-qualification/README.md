# Issue #411 preparation (not external qualification)

This directory is preparation for the Go-owned R-EXT task. It does not authorize
execution, create credentials, approve effects, start services, or call a provider.
The existing `codex_qualification_rext` identity and real task claim remain
independent gates; this script does not mint either one.

## Runtime closure and remaining live gates

The current implementation recovers repeated checkpoints from their original
Go commit/receipt evidence. It does not repackage an old commit with a new
revision or generation. The offline qualification fixture exercises the sealed
worker, real PostgreSQL, natural approval pause and canonical resume; the
separate provider-cache regression checks that the first logical call is not
repeated. Neither is a real provider or human Workflow Trust qualification.
Historical #433 failures remain evidence of their original candidates.

The private send journal and authenticated current-gauge adapter are implemented
under this PR's human-delegated source-maintenance scope. No reviewed
provider/model currently supplies a verifiable 8,192 input-plus-output token
hard bound. `SEND_TOTAL_TOKEN_UNVERIFIED` therefore refuses physical sending;
`max_tokens` is only an output cap. There is no test flag, capability assertion,
provider fallback or runtime approval that relaxes this refusal.

Preparation readiness is derived from explicitly matched candidate evidence.
Without that evidence it remains NOT_RUN/BLOCKED; fixing #433 never enables
live execution. Identity, claim, provider, human decision, Workflow Trust and
an actual 600-second drain window remain independent gates.

## Safe preparation commands

```bash
bunx vitest run packages/workflows/src/__tests__/r-ext-go-qualification.test.ts
bunx tsc -p scripts/r-ext-go-qualification/tsconfig.json
bun scripts/r-ext-go-qualification/preflight.ts --candidate <full-current-commit>
```

The preflight command is read-only and intentionally exits **2** for the known
unverified live gate, or **1** for invalid inputs/source inspection. It requires
tracked-clean candidate inputs and compares the real file-loader source and
lock bytes with regular files committed in the exact HEAD. HEAD/tree and tracked
status are rechecked after inspection. Untracked target inputs, staged or
unstaged changes and mid-inspection drift are rejected without emitting a
candidate report. Unrelated untracked files are not candidate content.
The command never calls GitHub or a model.

## Prepared pieces and explicit missing pieces

- `preflight.ts`: candidate/tree, clean status, real file-loader source bytes and
  lock identity. Claim, actual provider, bundle and image qualification remain
  independently unverified.
- `campaign.ts`: historical preparation transitions and exclusive evidence
  creation/readback. These files cannot initialize or reset execution allowance.
  Runtime registration is a separate explicit host operation:
  `registerWorkflowSendCampaign` binds the candidate, source, worker,
  workspace/run, route, provider/model and fixed ceilings. The worker opens an
  existing registration by `campaignBindingHash`, sealed in the workflow input.
  It never creates one. Registration refuses an existing Go run or directory.
- The private runtime journal adds four attempt slots and the two main-chain
  reservations to Go's existing budget authority. Its nonblocking owner lock,
  append/fsync/readback and immutable fact members preserve uncertainty rather
  than retrying it. An unconfirmed write keeps the lock; truncated, missing,
  linked or changed evidence is refused. Complete journal-prefix rollback is
  checked against immutable members and Go's canonical cumulative frontier.
  These checks do not provide anti-rollback authority for an administrator
  restoring the entire registration and every immutable member, particularly
  for not-sent attempts that never reserved Go budget. Restoring both canonical
  authorities is likewise outside the supported model. Such restoration must
  never be used to regain allowance; no worker recovery path performs it.
  Measured overage and unknown results freeze successors. Not-sent requires a
  definitive Go rejection, a host pre-transport observation and a fresh proof
  of no open reservation. No zero-usage receipt is invented to free a slot.
  Matching run/candidate cache evidence uses no new slot; cache gaps refuse
  re-sending. Go remains the reserve/settle authority, including stricter caps.
- `approval.ts`: read the actual pending approval through the production store;
  no decision authority, binding minting, TTY answer or status write is exposed.
  For independently authorized live work, use the existing human-attested MCP
  composition and exact `openslack_decide_workflow_approval` operation. The human
  reviews run/approval/context and answers the controlling TTY. A script or agent
  must never supply the answer. Resume promptly: current v2 execution authority
  is also bounded by decision time +60 seconds.
- `observe.ts`: a read-only observer abstraction using the supplied monotonic
  clock and actual read completion time; exactly `t0 + 15k` seconds, k=1…40.
  A missing/invalid read or a completion that misses the next slot fails the
  window; no catch-up rows are fabricated. The clock supplies now, wallNow,
  sleep and schedule(absoluteDeadlineMs, callback), returning a cancellation.
  Waiting and read deadlines use that same monotonic domain; a resolved wait
  without time progress fails immediately. Fixed reasons distinguish clock,
  transport, timeout and invalid-snapshot failures without archiving raw errors.
  Clock entry failures return `clock_invalid`; absent valid wall time is omitted,
  never fabricated. Cancellation failures retain validated snapshots and an
  established primary reason; a secondary fixed `cleanupReason` records failed
  cleanup. Early/synchronous scheduling is clock failure, not a read timeout.
  `now` and deadlines share a monotonic domain; wall time must not go backwards
  and elapsed time must differ by less than 15 seconds. A resolved sleep must
  advance `now`. No filesystem or coarse-clock exception relaxes these bounds.
  `createDrainAuthorityObserver` composes authenticated loopback reads of the
  current workspace/epoch gauges, canonical D2 and v2 effect-sibling authority.
  Missing, duplicate, invalid or foreign metrics fail. It never substitutes
  total runs, cumulative counters, effect shadow or local RunStore state.
  `runnerDrained` includes current jobs, leases and unfinished bindings;
  `outboxDrained` requires the real durable outbox to be empty. Exact historical
  settlements/recovery pauses do not become permanently active work. Each
  sample checks binding bookends and records only counts and evidence digests.
  Readers neither initialize missing authority roots nor perform recovery.
- `evidence.ts`: hashes, strict evidence primitives and honest NOT_RUN/BLOCKED
  layers. It does not publish or promote any result.
  UTC evidence uses the existing four-digit-year wire predicate; wider ISO
  predicates used elsewhere are unchanged.

## Before any live run

1. Verify the current candidate's full normal-path offline evidence, required
   CI and review. Freeze its clean SHA, sealed bundle, allowlist and pinned
   PostgreSQL image digest; old green heads do not prove this candidate.
2. Revalidate the actual principal, permission snapshot, valid claim and exact
   provider binding. No Aby identity substitution. No public fallback or TS writer.
3. Independently verify a supported provider's total-token guarantee before
   explicit campaign registration. The present guard refuses all unverified
   providers. Do not run the fixture simply because it loads successfully.
4. Preserve independent worktree/database/container/evidence/run/job/epoch state.
   Test approval wait and completion restarts without overwriting failed evidence.
5. Keep the existing limit: at most **4 provider attempts**, **8,192 total tokens
   per attempt**, **32,768 campaign tokens**. The normal chain uses two calls.
   Confirm prompt/output/turn counting and server-enforced bounds before sending;
   an output `max_tokens` value alone is not a total-token guarantee. No automatic
   retry, budget reset, fixed-dollar substitute, or raw provider response archive.
6. Execute the independent human decision and canonical resume using supported
   production paths. First provider call and audit effect must not replay.
7. Prove fail-closed negative cases before any provider call where possible;
   preserve unknown results for reconciliation. Run a real 600-second drain
   window after closing admission. A fake test clock is only local test evidence.

Report local regression, full sealed composition, hosted CI, provider/GitHub
qualification, human approval, merge and release separately. Current helpers do
not close #411, #433, R-REC/R-DOC, GS10–GS13 or any release gate.

## PR #435 review repair boundary (2026-11-05)

These repairs are human-delegated source maintenance on the existing Draft PR,
not execution by the qualification principal. They cover preparation helpers,
shared Workflow validation/read/layout mechanics, their tests, the root typecheck
entrypoint and necessary existing source pins and generated telemetry. They do
not bootstrap an identity, change registry permissions, renew a claim, grant live
execution, approve an effect or close #411/#433. Formal qualification remains
BLOCKED/NOT_RUN as stated above.

The original Claude Code review contained 32 angle-level candidates. The table
retains all original IDs under 27 topic groups; maintenance suggestions and
corrected attributions are not counted as independent production vulnerabilities.
The original incomplete verification reports and the unrelated #438 failure stay
historical. Validation results belong to the exact PR head and its evidence,
not to this static disposition table.

| Group | Original IDs | Topic                         | Disposition and regression boundary                                                                                                              |
| ----- | ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| G01   | C-1          | Windows integration budget    | Use the existing platform timeout only for the real-ACL initial/pause case; keep Linux at 5 seconds and Windows at 120 seconds.                  |
| G02   | B-1, E-1     | Frozen candidate identity     | Reject dirty tracked inputs, untracked targets, byte mismatches and HEAD/lock/source drift; clean inspection remains BLOCKED.                    |
| G03   | B-2          | Campaign correlation wording  | Describe the format check as correlation only; registration and durable live-send admission remain unimplemented.                                |
| G04   | A-1          | Stalled observation clock     | Reject a resolved sleep with no progress; do not spin or fabricate a sample.                                                                     |
| G05   | A-2, E-2     | Observation time domains      | Clock owns the absolute read deadline and cancellation. The NTP/native-timer claim is not adopted; injected-domain divergence is covered.        |
| G06   | A-3          | Persisted main-chain slots    | Validate every prefix with the same slot rule used by beginAttempt; impossible histories are refused.                                            |
| G07   | A-4, D-1     | UTC timestamp bounds          | Reuse the four-digit UTC predicate. The wider general ISO predicate remains unchanged.                                                           |
| G08   | D-3          | Not-sent usage evidence       | Require zero usage and no usage receipt for not_sent; preserve and refuse invalid old evidence.                                                  |
| G09   | D-2          | Read versus payload failure   | Use distinct fixed reasons for transport, timeout, invalid snapshot and clock failure; archive no raw error or rejected payload.                 |
| G10   | C-2          | Root typecheck coverage       | Include the preparation script project in the root gate; a disposable type-error mutation demonstrates the entrypoint.                           |
| G11   | REU-1        | Raw SHA-256 helper            | Reuse the existing raw workflow-source hash implementation without changing digest spelling.                                                     |
| G12   | REU-2        | Timestamp helper reuse        | Use the shared UTC validator rather than another Date round-trip implementation.                                                                 |
| G13   | REU-3        | Identifier semantics          | Share neutral hash/approval rules; retain the deliberately narrower campaign alphabet and test its sealed-source parity.                         |
| G14   | REU-4        | Closed inert evidence         | Reuse descriptor-based closed-record mechanics with explicit optional fields; reject proxies, accessors, symbols and foreign prototypes.         |
| G15   | REU-5        | Campaign file I/O             | Reuse stable bounded reads with an explicit single-link policy. Keep exclusive new-file creation: overwriting atomic writers are not equivalent. |
| G16   | REU-6        | Candidate Git semantics       | Reuse candidateRevision tracked-clean policy; unrelated untracked files are not frozen inputs.                                                   |
| G17   | REU-7, ALT-5 | Approval-root layout          | One internal layout resolver serves both production writers and preparation inspection; no decision authority or public package export is added. |
| G18   | ALT-1        | Budget literals               | Share campaign ceilings and main-chain purposes; cross-check the necessary sealed fixture literals.                                              |
| G19   | ALT-2        | Approval blocker              | Derive the inspector blocker from preparationStatus.                                                                                             |
| G20   | ALT-4        | Sealed preview blocker        | Cross-check preview and whenToUse against preparationStatus while keeping source self-contained.                                                 |
| G21   | ALT-3        | Go authority test composition | Share route, deterministic authority and production projection assembly across both test consumers; keep real effect authorization.              |
| G22   | SIM-1, EFF-2 | Repeated preflight reads      | Remove the unused first bookend read and repeated hash; retain independent post-load and committed-byte checks.                                  |
| G23   | SIM-2        | Freeze-rule duplication       | One campaign inspection computes frozen state for both validation and transitions.                                                               |
| G24   | SIM-3        | Redundant drained guards      | Read already-validated counters directly when checking whether authority is drained.                                                             |
| G25   | SIM-4        | Repeated overage assertions   | Separate measured-overage preservation from the four-slot and duplicate-settlement regression.                                                   |
| G26   | SIM-5        | Temporary directory roots     | Use tmpdir consistently; keep test artifacts in owned temporary directories.                                                                     |
| G27   | EFF-1        | Windows security cost         | Retain real ACL hardening and native-process cost intentionally; add no production security-injection switch.                                    |

## Separately authorized #438 maintenance on this PR

The requesting human expanded this repair on 2026-11-05 to the existing
`watch-daemon.ts` and its test file. This remains source maintenance through the
configured bot; it does not extend the qualification identity or authorize live
execution. No new PR or public daemon API is introduced.

At preparation repair head `57d2952f`, Windows job `127114787647` in workflow run
`41988480492` failed in the slow-chunked timeout test with `ECONNRESET`, after
logging port 3389: 3,338 passed, 1 failed, 12 skipped. That failure is retained,
not retried away. It is a different case from the earlier #438 unknown-action
failure. Both mention port 3389, but the exact old reset cause remains unknown.
An isolated native Windows probe demonstrated that an IPv4 listener and a
wildcard IPv6 listener can both bind the same port while IPv4 requests reach
only the former. This is an endpoint-ownership counterexample, not a historical
root-cause claim.

The tests now retain OS-assigned port-0 listeners and inspect their actual bound
ports. Concurrent requests prove that each endpoint mutates only its own store.
The existing public `start(port): Promise<void>` and default bind behavior remain;
listen failures reject, release startup state and start no delivery/profile
worker. Invalid and occupied endpoints are covered, including successful reuse
after rejection. Request, response, abort, close and JSON failures settle once;
premature responses and disconnects reject. The slow-request helper does not
suppress resets, and no retry, longer timeout or skipped Windows case is added.
Required current-head checks and human governance remain independent gates.

Independent review of the first #438 patch found an idle-stop/start race: a
stop could consume a newer listener after yielding to worker cleanup. Its two
regressions failed before the follow-up. Startup now refuses while a stop owns
the lifecycle, concurrent stops share one cleanup, and cleanup captures its
listener before awaiting. Restart is allowed after confirmed cleanup. The
intermediate patch and failed regressions remain recorded.

## PR #435 follow-up review: 23 records (2026-11-06)

This is the same human-delegated source-maintenance delivery on the original
Draft PR. No qualification identity, registration, credential, deployment,
approval or merge authority is created. The current campaign has four attempts,
8,192 tokens per attempt and 32,768 total; unknown and measured overage still
freeze subsequent attempts. Unknown usage has neither a token count nor a usage
receipt. Invalid retained evidence is refused without rewriting it.

| Record | Disposition                                  | Verification boundary                                                                                                                                                                                                                                                                                                                |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1      | Corrected attribution; coverage strengthened | The cited Windows failure belongs to `57d2952f`, not reviewed head `dadcb2e2`. Current-head Windows CI and three native rounds passed. Strict socket errors remain failures; the timeout regression verifies complete 408 framing, connection close, zero admission and bounded cleanup. The historical reset cause remains Unknown. |
| 2      | Fixed                                        | Cancellation cannot discard a validated snapshot or replace an established primary failure; secondary cleanup failure has a fixed code.                                                                                                                                                                                              |
| 3      | Fixed                                        | Synchronous/early schedulers report clock failure. Registration failure starts zero reads; an abort-aware read retains its actual first settlement.                                                                                                                                                                                  |
| 4      | Fixed                                        | Entry clock exceptions, non-finite readings and invalid UTC return bounded clock diagnostics without raw exception text or a fabricated timestamp.                                                                                                                                                                                   |
| 5      | Safety boundary retained                     | The Clock interface documents the existing two-domain coherence bound; 14,999/15,000 ms regressions preserve strict rejection.                                                                                                                                                                                                       |
| 6      | Fixed                                        | Stop owns cancelled startup; start rejects and no delivery/profile workers start. Cleanup finishes before restart.                                                                                                                                                                                                                   |
| 7      | Fixed                                        | Unknown usage with a receipt is refused by both transition and persisted-read validation. The open attempt and retained bytes are unchanged.                                                                                                                                                                                         |
| 8      | Fixed                                        | Cache lookup uses the actual resolved ID delivered to the launcher, tested with both resolution states.                                                                                                                                                                                                                              |
| 9      | Fixed                                        | Shared fixtures require a distinct explicit runner hash; independent authority/runner builds and stale runner rejection are exercised.                                                                                                                                                                                               |
| 10     | Safety boundary retained                     | Campaign evidence still requires a single-link regular file at every observation; no speculative filesystem bypass is introduced.                                                                                                                                                                                                    |
| 11     | Safety boundary retained                     | A resolved wait without monotonic progress fails immediately; no stalled-clock loop or fabricated observation is allowed.                                                                                                                                                                                                            |
| 12     | Completed                                    | A pure internal layout resolver serves writers, observation, attestation, Windows security repair and shadow/protected roots. Existing custom-root and path-security controls remain.                                                                                                                                                |
| 13     | Implemented with explicit authorization      | `WatchDaemon.address()` returns a frozen independent OS-bound address or null. `start(): Promise<void>` and default bind semantics are unchanged.                                                                                                                                                                                    |
| 14     | Simplified                                   | All drained snapshot test data derives from the existing helper.                                                                                                                                                                                                                                                                     |
| 15     | Simplified                                   | Preparation fixtures use the existing canonical temporary-directory helper.                                                                                                                                                                                                                                                          |
| 16     | Partly simplified; attribution bounded       | Tests use the existing executable resolver. Production preflight retains its correct platform selection and imports no test helper.                                                                                                                                                                                                  |
| 17     | Simplified                                   | Obsolete candidate cleanup and private server reflection are removed; lifecycle assertions use the public read-only address.                                                                                                                                                                                                         |
| 18     | Simplified and fixed                         | Ordinary scheduler try/catch and one first-settlement latch handle scheduling, read, abort and late results without an orphan rejection catch.                                                                                                                                                                                       |
| 19     | Simplified                                   | A run-local commit helper retains all four checkpoint artifact bytes, optional hashes and ordering. This does not repair or bypass #433.                                                                                                                                                                                             |
| 20     | Simplified                                   | One single-link predicate is applied independently before opening, on the FD and after reading.                                                                                                                                                                                                                                      |
| 21     | Simplified                                   | Each failed sample and returned result use the same derived primary failure.                                                                                                                                                                                                                                                         |
| 22     | Simplified                                   | Validated timestamps and numeric usage are bound once; redundant String/Number coercions are removed.                                                                                                                                                                                                                                |
| 23     | Simplified                                   | One exact multi-path tree query and one bounded binary batch read replace four input Git commands. Missing, malformed, oversized and trailing batch output are refused; candidate bookends remain.                                                                                                                                   |

The first implementation-stage regressions, review feedback and unsuccessful
checks remain in the external evidence batch; they are not retrospectively
reported as passing. Final results must name their actual commit/platform.
Previous cohort, CI and artifact results remain historical, and skipped checks
are not passes. That cohort preceded the runtime closure follow-up below;
it did not establish real provider qualification, human Workflow Trust or
human PR approval.

## Runtime closure follow-up (2026-11-06)

All changes remain on Draft PR #435. Source maintenance does not use or expand
the qualification principal, register its identity, renew a claim, approve a
real effect, merge, deploy, or close #411. No model call or production history
repair is included.

| Work                      | Required evidence                                                                                                                                                                        | Boundary                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| #433 anchored replay      | Real initial run, committed checkpoint, natural pause, fixture-human decision and canonical resume through the sealed worker and isolated PostgreSQL; exact original checkpoint retained | Offline fixture decision only; no production human approval                 |
| Private send admission    | Exclusive registration, independent-process winner, Go frontier binding, durable fact members, refusal before fetch, missing/partial history and cache negatives                         | No reviewed provider total-token contract; physical sending remains refused |
| Current drain observation | Authenticated actual Go services, pending approval before resume, completed effect after resume, real unpublished outbox remaining nonzero, and exact reconciled history excluded        | Real 40-sample/600-second qualification remains NOT_RUN                     |

The result summary names the final source SHA, worker/package digests, actual
Linux/native-Windows rounds, current-head CI, independent source review and
PRMS. Intermediate setup failures, behavior REDs and old Unknown records are
retained separately. No skipped check is reported as passing.

The real sealed fixture also exposed pre-admission heartbeats and exact receipt
repeats from the existing transport retry while a durable ACK was in flight.
The session now waits for accepted admission, retains cancellation heartbeat
semantics, and recognizes only a bounded history of fully validated, durably
acknowledged receipt and decision hashes. A repeat does not advance authority state or resend
an effect; changed frames still fail. These failures and their deterministic
regressions are retained. No retry, timeout or worker-count setting was increased.

Settlement keeps both the raw request-byte digest and the provider receipt's
existing domain-separated request digest. The two producers share the internal
hash primitive; this changes neither the Go protocol nor the public Agent Runtime
barrel. Positive and interrupted-settlement tests use synthetic already-admitted
facts to isolate settlement behavior. They never relax physical-send admission.
The intermediate 08cf8ced Linux broad cohort had two 5-second timeouts; its native
cohort was interrupted when confirmed contract repairs superseded that candidate.
Those records are retained and are not passing final-candidate rounds.

The sealed PostgreSQL composition is mandatory in the existing host
`workflow-control-postgres-gate.sh gs9e-budget` gate, with the explicit
`sealed_worker_integration` build tag and exact `TestGS9F2SealedCheckpointResume`
test name. It requires the installed Bun/Node toolchains; it is not part of the
Go-only container profile. No test skips or required-check changes replace it.
The 438854bd container failure exposed the former dependency mismatch and is
retained. Its full local Linux cohort also recorded three unchanged-suite
timeouts; separate hosted results and diagnostic runs do not erase those failures.

## Remaining local validation follow-up (2026-11-06)

The 303e2305 local full result (9,271 passed, two failed, 25 skipped) remains a
failed historical run. Its missing timing observations cannot be reconstructed.
A new real-pipe regression reproduces the missing-stall assertion when real
final diagnostic persistence spends the original cleanup allowance. Cancellation
fixtures now begin the actual public close operation before synchronously
stalling the parent; they do not depend on a 50ms timer running first. The 600ms
return assertion samples the captured return boundary, excluding later witness
reads and assertion work. Real process exit, the original 100ms cleanup budget,
the independent 500ms close observation and zero-effect assertions remain.

The Linux administrator wrapper previously placed 41 independent Python tests,
including real file and directory synchronization, inside one default five-second
Vitest case. The first repair at 9d519882 split those tests into seven classes;
its full Linux run still failed when the 16-case backup class took 6,801ms
(9,280 passed, one failed, 25 skipped). That failed cohort remains historical.
The wrapper now maps each of the 41 existing independent unittest methods to
its own Vitest case under that same default limit. This adds interpreter startups,
not a production performance claim. The existing Python runner records test IDs
at the actual execution callback. Independent discovery must match the explicit
case matrix; exact method selection, duplicate-free execution and the full
41-case union are checked. Partial name-filtered diagnostics explicitly report
incomplete coverage. Unknown selectors reject before execution.
Native unsupported-platform tests still exercise real refusal and zero target I/O.
No production code, timeout, worker count, retry or skip policy is changed.

The 05afcf34 standalone Linux run passed 9,314 cases with one failure and 25
skips: the existing full Go-verifier matrix exceeded its unchanged 90-second
limit. The preceding overlapping native/Linux run (9,297 passed, 18 failed,
25 skipped) is also retained; that scheduling deviation does not establish the
cause of every failure. The fake Docker fixture now uses equivalent Bash
built-ins for argument concatenation and its owned-file read, removing repeated
utility/subshell launches. Regression checks cover empty and quoted owner data,
argument escaping and exact fake responses. The real verifier invocation, full
positive/failure/skip-selector matrix and its 90-second budget remain unchanged.
The verifier regression is already a reviewed source input. Its existing digest
and corresponding Go expectation are refreshed together; the 233 binding keys,
paths and authority scope stay unchanged. The stale-pin contract failure is
retained separately from implementation and platform results.

The 9d6ec457 complete Linux result (9,313 passed, three failed, 25 skipped)
is retained. Its Go-verifier matrix passed in 61.3 seconds; three Cleanup merge
and drift cases exceeded five seconds while also creating their nine-PR disk
precondition. Those cases now reuse the existing terminal-fixture setup hook.
Drift setup performs real confirmed merges with a five-second bound; the actual
decline/continuation and drift assertions keep their original five-second cases.
The existing setup limit, real persistence, isolated directories, mutation counts,
snapshot checks and cancellation/drain cleanup remain. No campaign state is
fabricated and no real qualification PR is created.

The 7ea68e49 full result (9,311 passed, five failed, 25 skipped) is also
retained: four other Cleanup cases and the combined observation-inventory /
failed-write case exceeded five seconds. The Cleanup fake transport now yields
on its first request and every eight requests rather than on every synthetic
response. Each request retains both cancellation checks and real persistence;
the original first-request cancellation case remains. A ninth-request regression
checks the actual yield cadence, cancellation cause, drain, preserved prefix and
absence of late calls or replay after directory cleanup. This is fixture
scheduling, not a production RPC latency guarantee or a reconstructed cause for
all historical failures. The observer test keeps the full eight-commit sequence
and moves its already-independent failed store/port into a separate case; both
retain their existing platform deadlines and all prior assertions.

The 23808383 full result (9,317 passed, one failed, 25 skipped) remains
historical FAIL. Its only failure was another merge-refusal case combining
creation/close setup with its five-second behavior check. All remaining merge
cases that start from a closed fixture now use the same existing bounded setup
hook, including repository-setting drift and missing-ref refusal. Their original
assertions and five-second behavior limits remain; actual creation itself stays
in the creation tests. No setup state is shared across cases or fabricated.

New candidate regression, full-suite, CI and package evidence belongs to its new
commit. Earlier failures remain historical; real provider qualification, human
Workflow Trust/approval and the actual 600-second window remain separate gates.
