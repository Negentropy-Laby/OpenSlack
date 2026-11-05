# Issue #411 preparation (not external qualification)

This directory is preparation for the Go-owned R-EXT task. It does not authorize
execution, create credentials, approve effects, start services, or call a provider.
The existing `codex_qualification_rext` identity and real task claim remain
independent gates; this script does not mint either one.

## Current code blocker

**#433 blocks the complete sealed initial → pause → approve → canonical resume
composition.** The sealed worker reconstructs old checkpoint evidence using the
new control revision/generation. Current strict TS/Go validators correctly reject
that shape. Do not weaken those validators, seed a paused run, use a test writer,
skip a checkpoint using budget heuristics, or label a deterministic test as real
qualification. Runtime repair is a separate task and scope.

The fixture deliberately retains normal checkpoint re-entry so that this defect
is exposed rather than bypassed. Its exact agent is `codex_qualification_rext`;
bootstrap/principal resolution alone does not prove a provider binding. The
Workflow resolver and the installed provider must be verified independently.

## Safe preparation commands

```bash
bunx vitest run packages/workflows/src/__tests__/r-ext-go-qualification.test.ts
bunx tsc -p scripts/r-ext-go-qualification/tsconfig.json
bun scripts/r-ext-go-qualification/preflight.ts --candidate <full-current-commit>
```

The preflight command is read-only and intentionally exits **2** for the known
BLOCKED live gate, or **1** for invalid inputs/source inspection. It requires
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
- `campaign.ts`: strict immutable-copy budget transitions and exclusive initial
  evidence creation/readback. All attempts, including failures and not-sent
  attempts, consume campaign slots. Two main-chain slots remain reserved. Unknown
  results freeze further attempts; no retry or reset is provided. **A live
  durable per-attempt send ledger is not yet implemented.** These pure helpers
  do not admit a send and must not be mistaken for such a gate.
  Persisted prefixes must preserve the same main-chain slots as transitions.
  A not-sent settlement has zero usage and no usage-receipt hash. Invalid old
  evidence is refused, never rewritten into a fresh allowance. The workflow's
  campaignId is only an evidence correlation value, not verified registration.
- `approval.ts`: read the actual pending approval through the production store;
  no decision authority, binding minting, TTY answer or status write is exposed.
  After the code blocker is repaired, use the existing human-attested MCP
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
  No Go metric source is wired yet.
- `evidence.ts`: hashes, strict evidence primitives and honest NOT_RUN/BLOCKED
  layers. It does not publish or promote any result.
  UTC evidence uses the existing four-digit-year wire predicate; wider ISO
  predicates used elsewhere are unchanged.

## Before any live run

1. Repair #433 in its own reviewed runtime scope. Prove the full normal-path
   deterministic composition, then merge preparation and refreeze a clean SHA,
   sealed bundle, allowlist and pinned PostgreSQL image digest.
2. Revalidate the actual principal, permission snapshot, valid claim and exact
   provider binding. No Aby identity substitution. No public fallback or TS writer.
3. Complete the durable attempt/send gate and read-only Go metrics adapter under
   reviewed scope. No current helper is a live runner. Do not run the fixture
   simply because it loads successfully.
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
