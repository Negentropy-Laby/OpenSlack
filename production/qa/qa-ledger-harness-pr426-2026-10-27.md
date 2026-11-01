---
schema: openslack.document.v1
id: qa-ledger-harness-pr426-2026-10-27
status: In Review
authority: index
audience:
  - contributors
  - reviewers
owner: qa
updated: 2026-11-01
sources:
  - docs/architecture/adr/adr-0003-harness-closed-loop-repair.md
  - design/cdd/workstreams/agent-runtime-and-aby/README.md
  - docs/architecture/components/agent-runtime.md
---

# PR #426 repair disposition ledger

## Candidate, authority and limits

This working ledger accounts for all 51 numbered findings supplied by the
requesting maintainer. It is not a claim that 51 tests passed, an independent
review, a qualification receipt or a completion decision. Repairs remain on
`feat/openslack-harness-bridge-20261024`, starting at
`e0633550ae3e38e26350b79eb347ede52a99a4a2`, for the existing Draft PR #426.
Uncommitted repairs are identified by the per-command input manifests; the
starting commit does not identify those bytes. Final candidate validation,
independent review, hosted CI, real-subject/model execution and human acceptance
remain separate and pending until their own evidence is recorded.

The original review is retained without correction or replacement:

- Original: `D:/tmp/pr426-review/pr426-all-findings-from-subagent-records.md`.
- Recoverable local copy: `REVIEW-51-ORIGINAL.md` under the evidence directory below.
- Size: 25,854 bytes; SHA-256:
  `5a95974ab9d3d8cf9b7d0aa7604e83ac141a99c07540d67e2b0fb24ef3ce61b3`.
- Original accounting: 70 raw candidates, 51 dispositions: 42 confirmed,
  5 plausible and 4 refuted. The two absorbed performance observations remain
  included in findings 21/29; they are not extra defects.

The requesting maintainer formally accepted the exact ADR-0003 Proposed input
`5efa47bd8960c6e3aead168c01b10a84c83f514bf572b4c19bfc8aa1d2b01f63`
(16,248 bytes). Its acceptance record preserves the actual chat provenance and
does not fabricate a GitHub review identity. The private Windows Job supervisor,
strict provider-wide wire checks, bounded full-payload chunking and durable
admission/state ownership are covered by that decision. Local fixture repairs
and duplication controls do not create new execution authority.

No Harness/Aby source patch, identity bootstrap, new registry permission,
automatic redispatch, old-worktree cleanup, new PR, approval, merge or release is
part of these repairs. Adding the prospective text fixture does not provision
an identity or approve a live task.

## Evidence vocabulary

Local raw records are under
`.openslack.local/harness-evidence/20261024/repair-426-20261026T0756Z-gg9PtI`.
Their availability is local, not implied public attachment publication.

| Evidence | Actually observed scope | Limit |
| --- | --- | --- |
| C4 | `C-FOCUSED-R4`: 88 passed, 1 failed, 1 explicit Windows-platform skip, ten files. Includes CLI 34, launcher policy 4, provider policy 7, artifact 16, shutdown 4, binding 6 and deployment 2. | The invalid-UTF8 failure is retained, not reclassified; source changed elsewhere during the phase. |
| C5 | `C-PROCESS-R5`: 10/10 passed after the owned-stdin fix: six actual SDK/packed peer cases and four real MCP connection cases. | Linux/WSL keyless compatibility, not real-model or native-Windows acceptance; whole-tree inputs changed elsewhere. |
| NB | `C-PLUGIN-BUILD-R3`: formal TypeScript/public-API, seven JS artifacts, self-contained declarations and Go supervisor build passed with matching before/after input content. | A phase build, not the final candidate or native execution qualification. Later R4 build also passed but inputs changed elsewhere. |
| NJ | `NATIVE-JOB-R4-RESULT.json`: actual Windows x64, pinned Node 24.18.1, 9/9 passed; result SHA-256 `3440255de21eef75a8ba8b61c6c30fdc4b9a94e68ac064eda826dc737fb896ef`, 3,995 bytes. | Focused owned-process fixtures, not the full business loop. |
| NG | `NATIVE-GO-CREATION-R1.log` and R2 execute on actual Windows: the first branch injects `CreateJob` AccessDenied through the private test seam and proves failure handling without resume; the second invalidates the private Job handle and observes real `CreateProcessW` association rejection. Neither executes the marker child. Each log has SHA-256 `7db2319b1a7bfdafa0edad541bc36e3108e82bb5c148b0d3ad39192797201859`, 503 bytes. | Injected errno is not a measured OS permissions failure; cross-compilation alone was not counted as runtime evidence. |
| NP1 | `NATIVE-PATH-R1`: actual temporary Windows drive alias normalized to the same root/artifact hash; real directory junction rejected. | Only the selected alias case ran; 8.3 and portable-binding cases require their separately recorded run. |
| NP3 | `NATIVE-PATH-R3`: actual Windows 8/8 selected cases passed: genuine 8.3 spelling, drive alias/junction boundary, and six portable binding checks. Result SHA-256 `0b2bc54d23e742e6b1ccba3084cba57928fe88794a88640cc7e07eca00952de2`, 8,741 bytes. | Sixteen other artifact cases were not selected by this command; this is not a claim that its entire 24-case collection ran. R2 retains a fixture-command quoting failure. |
| V15 | `VAULT-51-REVIEW-GREEN`: implementation-author 15-case phase result, following the retained deterministic review counterexample. | Static review and author tests remain distinct; not final-candidate independence. |
| Pending | A/B state, protocol and full-candidate receipts are to be bound after the owners finish and the input set is frozen. | A writer's reported count is not substituted for an unread original log. |

Each final record must retain full candidate/tree and exact dirty-input hashes,
command, environment/version, time, exit status, scope and raw log. Preserved
RED/FAIL results stay historical failures. `Implemented` below means a code path
exists; it does not mean final verification has passed.

## All 51 dispositions

Paths in the table are repository-relative. `AR` abbreviates
`packages/agent-runtime/src/`; `Plugin` abbreviates
`integrations/deepseek-harness/`; `MCP` abbreviates `apps/mcp/src/`.

| # | Original mechanism | Current repair/disposition and exact paths | Regression/evidence and remaining gate |
| --- | --- | --- | --- |
| 1 | Failed/aborted confirmation strands a pending dispatch. | Implemented durable plan-bound phases, ownership/deadline and settlement: `AR/harness-task-host.ts`, `AR/harness-admission.ts`, `MCP/mutations.ts`, `MCP/governed-composition.ts`. | `harness-state-repair.test.ts`, `harness-confirmation-settlement.test.ts`: failed/aborted/uncertain confirmation, expiry and restart. Final receipt pending. |
| 2 | Close races with asynchronous publish before active ownership. | Implemented ownership before publish and closing checks with durable stop facts: `AR/harness-task-host.ts`, `AR/harness-stop.ts`. | Delayed publish/close regression in `harness-state-repair.test.ts`; final receipt pending. |
| 3 | Recorder and report read/merge/write overwrite each other. | Implemented store-owned functional transactions for every writer: `AR/run-store.ts`, `AR/recorder.ts`, `AR/harness-task-host.ts`. | Two independent writers/report preservation; `run-store.test.ts`, `harness-state-repair.test.ts`. Final receipt pending. |
| 4 | 256 valid frames poison a session during authorization. | Implemented byte-bounded draining/control handling: `AR/bridge-adapter.ts`, `AR/bridge-wire.ts`. | Long authorization plus valid heartbeats/progress, real overflow rejection; Bridge owner receipt pending. |
| 5 | Legal large payload cannot fit a 1 MiB frame. | Implemented negotiated `chunked-json.v1`, 16 MiB logical messages and full-evidence quota: `AR/bridge-wire.ts`, `AR/recorder.ts`, `Plugin/src/bridge.ts`, `Plugin/src/scope-evidence.ts`. | `bridge-wire.test.ts`, `harness-bridge.test.ts`, `scope-evidence.spec.ts`; full payload retained, no truncation. Final receipt pending. |
| 6 | Local bad model arguments destroy the entire token vault. | Implemented local-validation rejection without terminal disposal, entry-only expiry and post-await concurrency guards: `Plugin/src/confirmation-vault.ts`. | V15; `confirmation.spec.ts`, including concurrent admission, noncloneable input and cancellation. |
| 7 | Another agent's deployment breaks ordinary agent-bound serve. | Implemented explicit `--harness-task-host`; ordinary serve does not load deployment: `apps/cli/src/commands/mcp.ts`, `Plugin/src/connection.ts`. | C4 `mcp-command.test.ts` ordinary no-loader regression. |
| 8 | Default tests require an external Harness checkout. | Implemented optional ordinary project plus required explicit compatibility/inventory paths: `vitest.config.ts`, `Plugin/vitest.config.ts`, `package.json`. | `scripts/release/__tests__/test-entry.test.ts`; missing checkout must fail required CI/inventory, never silently skip it. Final full run pending. |
| 9 | Finally receipt failure overrides completed result/original error. | Implemented guarded advisory handoff recording: `AR/launcher.ts`. | C4 `launcher-policy.test.ts` successful result and original failed outcome both survive injected handoff failure; no cleanup. |
| 10 | Windows direct termination leaks SDK descendants. | Implemented creation-time nonbreakaway Job ownership and typed outer transport: `Plugin/native-supervisor/**`, `AR/deepseek-harness-provider.ts`, `AR/bridge-adapter.ts`. | NJ/NG: three generations, helper death, blocked input, output pipes, forged child receipt, force never success. Integrated final Windows loop pending. |
| 11 | Client 10 s shutdown budget is shorter than serial cleanup. | Implemented one shared absolute shutdown deadline: `Plugin/src/shutdown.ts`, `owned-sdk.ts`, `sdk-host.ts`, `connection.ts`; total task reserves cleanup in `AR/harness-task-execution.ts`. | C4 shutdown serial-budget regression, C5 actual clean SDK/MCP stop; delayed/failure owner regressions remain in final run. |
| 12 | Initial state read escapes execute failure recording. | Implemented admitted-owner wrapper and independent stop facts: `AR/harness-task-host.ts`, `AR/harness-stop.ts`. | Corrupted/busy state and restart preservation in `harness-state-repair.test.ts`; final receipt pending. |
| 13 | Busy/stale run lock prevents any persistent failure fact. | Implemented immutable stop intent outside state transaction; no orphan lock deletion: `AR/harness-stop.ts`, `AR/harness-task-host.ts`, `AR/run-store.ts`. | Contended/corrupt state blocks future report even when state patch cannot persist; final receipt pending. |
| 14 | Expired lease prevents read-only reconciliation of verified history. | Implemented historical observation separate from execution eligibility: `AR/harness-task-authority.ts`, `AR/harness-reconciliation.ts`. | Expired required-claim history plus source drift/revocation negatives; final receipt pending. No permission to execute is inferred. |
| 15 | The sole allowed fixture does not exist. | Narrowed original conclusion: an exact allow path may authorize creating a file; it is not inherently a dead principal. Added only `fixtures/harness-closed-loop.txt` with `before\n`. | Existence/content is a fixture precondition, not subject provisioning/task approval. Real subject and task remain pending. |
| 16 | Old Aby completion loses its final bounded grace. | Implemented separate at-most-1 s absolute completion grace, not weak parsing or unbounded cleanup: `AR/bridge-adapter.ts`. | Old-provider boundary completion and beyond-grace rejection in Bridge tests; final receipt pending. |
| 17 | Windows undefined O_NOFOLLOW silently follows links. | Implemented portable entry/FD/post-path and ancestor identity checks: `Plugin/src/startup.ts`. | C4 binding six cases on Linux/WSL and NP3 six cases on actual Windows. No SDK private field or local identity copied. |
| 18 | No deadline exists before the first handshake. | Implemented timer before dependency await/input plus owned stdin termination after close: `Plugin/src/startup.ts`. | C5 silent parent, invalid UTF-8 and truncated input exit nonzero with zero SDK/model/file action. Retained C4 hang prompted the stdin fix. |
| 19 | Deadline catch erases permission/crash cause. | Implemented typed cause-preserving failures and safe primary diagnostic: `AR/bridge-adapter.ts`. | Coincident deadline/denial/crash regressions; final Bridge receipt pending. |
| 20 | All filesystem errors misleadingly request rebuild. | Implemented stable own-data error-code classification through resolution: `AR/deepseek-harness-provider.ts`. | C4 EACCES/EPERM/EBUSY/EMFILE/ENOENT safe diagnostics plus real missing artifact; no raw paths/messages. |
| 21 | Repeated full deployment/Node hashing consumes task deadline. | Implemented early cutoff, one runtime walk and opaque synchronous phase-local plugin/Node observation: `AR/harness-artifacts.ts`, `AR/deepseek-harness-provider.ts`, `AR/harness-task-execution.ts`. | C4 forged/changed/cross-await observation rejection; measured phase read-count regression and final receipt pending. No cache crosses await or replaces authorization. |
| 22 | EOF shutdown error is rendered as startup failure. | Implemented lifecycle classification and one rendering path: `apps/cli/src/commands/mcp.ts`. | C4 EOF failure emits SHUTDOWN_UNCONFIRMED once, not START_FAILED. |
| 23 | Truthy host bypasses startup authority checks. | Implemented principal/workspace-bound, explicitly authorized local Workflow family selection: `MCP/governed-composition.ts`. | Authorized Harness-only principal need not have irrelevant Scenario authority; host with no usable authorized target must fail. Final composition receipt pending. |
| 24 | Injected host silently ignores worker binding flag. | Confirmed configuration ambiguity; implemented rejection before host construction: `apps/cli/src/commands/mcp.ts`. | C4 injected/dispatcher/worker conflict combinations and missing configured owner. |
| 25 | Fixed 1 s duplicate-admission wait reports false uncertainty. | Implemented visibility deadline tied to the owned admission and bounded read-only observation: `AR/harness-task-host.ts`, `AR/harness-admission.ts`. | Slow owner publication and same-key/different-request tests; final receipt pending. No second dispatch is used as recovery. |
| 26 | Stdin EPIPE can escape during end/flush. | Added real-stream error ownership and settlement: `AR/bridge-adapter.ts`. | Broken-pipe/backpressure race in Bridge regressions; final receipt pending. Original finding was plausible, not inherited as measured fact. |
| 27 | External closeSession abandons an in-flight waiter. | Fixed pre-existing public lifecycle hole: `AR/bridge-adapter.ts`. | In-flight close settles instead of hanging; final receipt pending. |
| 28 | Pre-initialize stderr can fill and stall MCP. | Confirmed installed MCP 2.2.0 exposes the early public PassThrough; drain before connect and bound startup: `Plugin/src/connection.ts`. | C5 real 512 KiB pre-initialize write fixture succeeds. `Plugin/tests/fixtures/mcp-server-stderr.js`; no upstream diagnostics retained. |
| 29 | Per-tool authority/path/recording rereads are expensive. | Partial, non-blocking P2. Transactional state/full-evidence fixes remove unsafe overwrites; repeated live task/principal checks still exist in `AR/harness-task-authority.ts` and must not be deleted to reduce counts. | Owner: Agent Runtime follow-up after P0/P1. Measure remaining work before safe same-phase coalescing. Not claimed fully optimized or closed. |
| 30 | Manual source list hashes 17 modules repeatedly. | Implemented directory-derived build domain and metadata-checked cached bytes: `AR/harness-task-host.ts`. | Source additions/renames/changes must invalidate observation; TS-source and JS-artifact domains are explicit, not falsely interchangeable. Final receipt pending. |
| 31 | Four private FD readers implement different identities. | Shared runtime leaf delegates stable FD bytes to Core while retaining caller link/ownership policy: `AR/harness-read.ts`, `harness-admission.ts`, `harness-artifacts.ts`, `harness-deployment.ts`, `harness-task-execution.ts`; package/lock metadata only. | C4 artifact/link bounds and A stable-read regressions; native portable binding remains its separate external-package implementation. Final combined receipt pending. |
| 32 | Nonfinite JSON numbers alias null in admission hash. | Implemented rejecting canonical encoder without operator package coupling: `AR/harness-admission.ts`. | `harness-input.test.ts` nonfinite/sparse/cycle/exotic values; historical hashes remain historical. Final receipt pending. |
| 33 | Three run ID grammars hide otherwise valid runs. | Shared exact `AR/run-id.ts`, consumed by admission, store, projection and provider. | Long valid ID remains queryable; invalid IDs remain rejected in `harness-input.test.ts`/projection tests. Final receipt pending. |
| 34 | Initiator/worker security wrappers drift independently. | Shared private callback projection/validation: `Plugin/src/callback-tools.ts`, `index.ts`, `initiator.ts`. | Vault/scope regressions retain distinct per-run vs admitted-run query authorization; final combined receipt pending. |
| 35 | Boolean/string family branches scatter through composition. | Scoped repair uses sealed reviewed-family metadata and selected local authority: `MCP/governed-composition.ts`, `MCP/harness-workflow.ts`. | Family-specific evidence remains intentionally separate; no generic resolver framework was added. Final composition receipt pending. |
| 36 | Harness plan rehydration is duplicated. | Shared `restoreHarnessWorkflow`: `MCP/harness-workflow.ts`, both callers in `MCP/governed-composition.ts`. | Same actor/workspace/correlation and resolver checks must apply to preview/confirm/effect; final receipt pending. |
| 37 | CI-only TEMP spelling repair leaves production aliases broken. | Guarded trusted Windows ingress normalization in `AR/harness-read.ts`, consumed by admission/artifacts/deployment, including descriptor parent. Junctions remain rejected. | NP1/NP3 actual drive alias and 8.3 roots preserve their artifact identity; actual junction rejects. These results were not inferred from Linux. |
| 38 | Atomic rename applies only to Harness state. | All-provider transactions use atomic publication: `AR/run-store.ts`. | Both provider families, concurrent writers, append/rename fault preservation in store tests. Final receipt pending. |
| 39 | Four provider-name checks own destructive lifecycle policy. | Trusted immutable `ProviderExecutionPolicy`: `AR/provider-registry.ts`, `launcher.ts`, `deepseek-harness-provider.ts`; unknown external transports preserve by default, Aby keeps its explicit existing policy. | C4 renamed-provider acceptance/preservation, missing acceptance preflight, immutable policy and original outcome regressions. |
| 40 | Two CI preparation copies can drift silently. | Minimal exact preparation/pin/order parity regression: `scripts/release/__tests__/workflow.test.ts`; pinned Go/supervisor verification in both authorized workflow files. | C4 seven workflow cases passed; no new preparation platform/tool or weakened check. |
| 41 | Callback tool names have three unshared spellings. | Shared bare/Bridge/SDK names in pure `AR/bridge-wire.ts`, consumed by permissions and external plugin startup/scope. | Exact four callbacks, no arbitrary target/name mapping; final protocol/scope receipt pending. |
| 42 | Every frame serializes twice and rebuilds tool map. | Encoder returns serialized frames; startup writes them once; mapping is module-scoped: `Plugin/src/bridge.ts`, `startup.ts`. | C5 actual SDK peer compatibility passed; chunk/full-evidence regressions receive final Bridge receipt. |
| 43 | Tool evidence duplicates lenient JSONL parsing. | Strict bounded streaming transcript variant shared by evidence validation: `AR/transcript.ts`, `AR/harness-task-execution.ts`. | Malformed/truncated/unbalanced/oversized evidence fails closed; full 9 MiB result coverage in state suite. Final receipt pending. |
| 44 | Strict wire checks are Harness-flag-only. | UTF-8, identity, payload and terminal checks are unconditional; trusted exit policy is separate: `AR/bridge-adapter.ts`, `AR/bridge-wire.ts`. | All-provider malformed-frame regressions plus explicit old-Aby timing compatibility; final receipt pending. |
| 45 | CLI owns Harness shutdown budget and policy. | Package-owned idempotent `createHarnessHostCloser`: `AR/harness-deployment.ts`; CLI only owns transport lifecycle. | C4 CLI EOF/owner cases and C5 actual MCP close; final combined receipt pending. |
| 46 | Two nearly identical response queue branches have implicit ordering. | One explicit queue/terminal/exit settlement path: `AR/bridge-adapter.ts`. | Queued terminal vs actual process exit/order regressions; final receipt pending. |
| 47 | Capability negotiation echoes unsupported requests. | Fixed pre-existing public method with trusted available/requested intersection: `AR/bridge-adapter.ts`. | Unknown versions/tools/MCP capabilities rejected by intersection tests; wire extension negotiation remains separately validated. Final receipt pending. |
| 48 | Write scope supposedly requires an unexpected Write+Edit pair. | Refuted original scenario; production prepare already requires Read/Write/Edit for writable tasks. No loosening: `AR/harness-task-execution.ts`, `Plugin/src/startup.ts`. | Missing capability remains pre-spawn rejection. No extra runtime permission granted. |
| 49 | Stripped environment supposedly breaks callback server. | Refuted original scenario; absolute native Node/JS entry uses no shell and callback path does not require the cited variables: `Plugin/src/connection.ts`. | C5 real read-only/task callback processes run with the bounded transport configuration. No credential/environment expansion. |
| 50 | Activity projection supposedly crashes the process. | Refuted: `MCP/context.ts`/`core.ts` convert projection failure to safe tool error; malformed evidence is not repaired or silently accepted. | Existing projection fail-closed tests; final combined receipt pending. No production fallback added. |
| 51 | Stuck MCP child supposedly leaks once per run. | Refuted with installed public MCP client 2.2.0 source: close owns EOF/TERM/KILL escalation. Forced or missing exit remains unknown, not success: `Plugin/src/connection.ts`, `process-observer.ts`. | C5 clean/unexpected-stop receipts; no private transport field or monkey-patch used. Full Windows owned-tree evidence is NJ, not inferred from SDK close alone. |

## Supplemental findings from independent repair review

These follow-up IDs do not replace, renumber or silently close the original 51.
An earlier GREEN applies only to its retained input manifest and measured scope;
the later consumer/build/independent-review checks remain separate.

| ID | Original links and mechanism | Evidence and current boundary |
| --- | --- | --- |
| S01 | 12/13/29: required lease expires while a canonical read, reservation transaction or report CAS waits. | `LEASE-51-RED-R1` retains three actual failures. Nominal phase/tool observations, in-lock and before-publication checks plus private denial restrictions are implemented. `STATE-LEASE-GREEN-R1` and the C consumer receipts are phase evidence, not final-candidate acceptance. |
| S02 | 1/3/12/14: final start/complete CAS or acceptance evidence wait crosses a lease/deadline or changes accepted file bytes. | Independent stop facts, final owned-CAS revalidation and absolute checks are implemented; original RED/phase logs remain distinct. Historical verified evidence is observable without treating it as execution eligibility. Final combined state review remains required. |
| S03 | 16/19/26/27: cancellation after async send/before waiter, or during clean shutdown, is missed or replaced by a crash. | Independent `CANCEL-R4` and `CLOSE-CANCEL-R3` replays confirmed denial against their exact phase bytes; source tests in `bridge-cancellation.test.ts`. Later start-guard changes require their own fresh build/replay. |
| S04 | 4/10/19: a real 717,844-byte pipe write stalls cancellation until the peer's natural exit. | `BACKPRESSURE-R1/R2` remain RED; independent `BACKPRESSURE-R3` observed cancellation with an unsettled real write and bounded actual exit. Late EPIPE is secondary evidence. This is not a claim about model/business acceptance. |
| S05 | 21/30/31/32/37: entry/lock-only hashes omit actual split/transitive bodies; unframed plugin file partitions alias; portable path/resolver shapes need fail-closed binding. | `C-DEPENDENCY-CLOSURE-RED-R2` preserves two real Node-import counterexamples with unchanged entries/manifests/locks; `C-PLUGIN-FRAMING-RED-R1` preserves the partition alias. Bounded installed-closure and framed plugin domains are implemented with stable FD streaming and metadata secret guards. Overbroad `credentials` name rejection and the legitimate 127,844,128-byte WASM resource are retained compatibility counterexamples, not upstream failures. Final safe footprint/build/native-alias receipts remain pending. The stopped callback measurement is not PASS. |
| S06 | 1/12/18/21: an eligible start crosses expensive runtime reads or SDK initialize/subscription awaits before executable work begins. | `START-LEASE-RED-R1` observed one real peer and scripted model request after expiry; A's nominal RunStart restrictions and the peer/SDK consumers are implemented. `C-SDK-START-PREVIOUS-BUILD-RED-R2` independently retains an old built SDK owner failing to deny after real initialize; its public-subclass clock seam and old artifact hashes are explicit. Fresh combined build/full-peer checks are pending. Its R1 invalid cross-process test-clock deadline is a fixture failure, not a product RED. |
| S07 | S06 successor: SDK prompt entry is eligible, but a public Agent preparation await crosses expiry before actual adapter dispatch. | `C-LLM-DISPATCH-REAL-RED-R1` records real SDK/code 0/complete/model requested after the known cutoff. `C-LLM-DISPATCH-REAL-GREEN-R1` records code 1/no complete/no model request through the same real-clock delay after adding the public `llm/stream` and lazy-iteration checks. Its 1 selected case does not represent the 10 deselected cases; `C-LLM-DISPATCH-SOURCE-GREEN-R1` separately covers seven SDK-host cases. R1 source/compiled artifacts and fixture remain recoverable; fresh full-candidate SDK review/validation is still required. No private-provider HTTP atomicity is asserted. |

Protected-name negative tests create no PEM/key material. They observe both the
buffered reader and streamed descriptor boundary. Early prototype measurements
did not retain that suffix-level trace and are not retroactively called zero-read.
No legacy run, deployment approval or historical PASS/FAIL was rewritten when
the new digest domains were introduced.

The safe compiled dependency measurement `C-INSTALLED-CLOSURE-MEASUREMENT-R2`
completed within the unchanged caps: the original Harness under `/tmp` observed
636 packages, 27,997 files and 528,913,908 bytes; the callback under the mounted
`/mnt/d` checkout observed 163 packages, 6,811 files and 56,826,736 bytes. Measured
durations were respectively 10,884.77 ms and 192,694.20 ms under Node 24.18.1.
Those are environment-specific phase observations, not universal timing budgets;
the mounted-path result motivates final same-input validation on the prepared
fresh Linux-filesystem copy without relaxing task deadlines.

## Remaining acceptance and delivery

P0/P1 repairs may proceed independently of the explicitly remaining P2 performance
work in finding 29. That deferral must not be presented as every surviving issue
fully optimized. Before a final technical-delivery claim, bind applicable full
tests, build/type/lint/workspace/docs/count/source-lock checks, the two-platform
artifact and process results, hosted checks and a fresh independent review to one
candidate. Root-only account rejection and real nonprivileged positive fixtures
remain distinct environment cases.

The approved principal/configuration draft is not a provisioned runtime identity.
Real-model Windows/WSL closed-loop dispatch, report, verified host acceptance and
same-run readback remain NotRun until their actual approved deployment exists.
Human business acceptance is NotRun. PR #426 remains Draft; no bot APPROVE,
auto-merge, merge, release, task completion or implicit governance promotion is
recorded by this ledger.

## Later verification phases — 2026-10-27 (not final qualification)

This addendum appends observed phases without rewriting the original 51 rows,
S01–S07, raw failures or their input identities. `V` rows are verification-input
or preparation corrections, not additional original product findings. Each run
retains its own source/artifact manifest; the different phases below are not one
final frozen candidate or an independent review by this implementation author.

| ID | Mechanism, disposition and exact scope | Observed evidence and limit |
| --- | --- | --- |
| S08 | Links 21/29/30/37: the consumer's installed-runtime discovery omitted the pinned workspace's `apps/*`, treating the frontend's source/debug output as third-party runtime content. `AR/harness-runtime-closure.ts` and the upper runtime-discovery section of `AR/harness-task-execution.ts` now derive visited application output from public `main`/`bin`/non-type exports and the explicit `dist`/`!dist/**/*.map` publication contract. JS, CSS, fonts, WASM, data, native resources and exact manifests remain bound; unknown/mixed output, aliases and escapes still fail closed. No Harness source or cap was changed. | `C-NATIVE-51-FOOTPRINT-R1` retains the old capacity failure. `C-APPLICATION-CLASSIFICATION-GREEN-R3` records 43 PASS and one Windows-only platform SKIP, not a test-name deselection. The later actual production public hasher in `C-NATIVE-51-PRODUCTION-HASH-R2` succeeded within the unchanged caps on Windows, taking 45,349.107 ms. The old diagnostic graph that discovered only `apps/cli` is not reused as the corrected graph or a new footprint count. |
| V01 | The first Linux full phase lazily created `packages/workflows/dist/workflow-runner-worker-bundle.cjs` during tests, changing the callback's bound artifact set. Formal `build:runner-worker` preparation now precedes artifact binding; it does not change frozen Worker code, wire/SQL contracts or source-lock bindings. | `QA51-FRESH-LINUX-R2-FULL-VITEST` remains 8,460 PASS, 10 FAIL and 18 SKIP with source stability but artifact drift. Its original bundle/before bytes are preserved. The formally prepared bundle is 3,114,396 bytes, SHA-256 `aaa37e32d1957d2e8d95f3a4598e26d3c6750d3cc3027d9f5ed44aef674b46c9`. Later scoped Linux R3 and Native R4 runs bound 5,597 actual artifacts before execution and observed unchanged bytes afterward; they do not replace the failed full phase. |
| V02 | `Plugin/tests/fixtures/sdk-caller.mjs` explicitly supplies `not_applicable` only for the synthetic caller/readonly SDK owner, which has no dispatched-worker or local-file authority. The two Bridge Guard fixtures use the required existing running-state checkpoint. These are test inputs, not a production missing-fact fallback or new principal authority. | `QA51-FIXTURE-DELTA-R3` records Linux Guard 44/44 PASS and the actual MCP full-peer/report/host-verified/readback/readonly/reconcile case PASS in 40.821 s; its 29 test-name deselections are not PASS. `C-NATIVE-51-MCP-CALLER-R4` records the same actual case PASS in 256.014 s with 134 scoped source inputs; `C-NATIVE-51-GUARDS-R4` separately records 44/44 PASS with 136 source inputs. Both Native phases observed 5,597 stable artifacts. The original task 240,000 ms, caller child 270,000 ms and MCP test 300,000 ms limits were unchanged. These counts are not added into a new whole-suite PASS. |
| V03 | The seven actual-deployment assertions were correct but synchronously blocked the test worker beyond its old 30 s budget. The requesting maintainer explicitly authorized only `Plugin/tests/deployment.spec.ts` and `tests/fixtures/deployment-validation.mjs` to use the fixed Node executable and the existing formal dist public entry in an awaitable child. All seven fresh production hashes and exact rejection assertions remain. The pure hash child has a maximum 300,000 ms computation bound; a bound violation immediately requests SIGKILL, followed by at most 10,000 ms only to observe actual close. Only this test has a 330,000 ms limit; the build test remains 180,000 ms. | `C-NATIVE-51-DEPLOYMENT-TIMING-R1` retains seven matched assertions taking 233,820.055 ms total, including one valid call at 34,141.357 ms. The new parent bounds combined stdout/stderr to 64 KiB and requires actual exit 0/null plus exactly seven named successful assertion receipts; errors, timeout, extra output or unknown close cannot pass. `QA51-DEPLOYMENT-DELTA-R4` records both Linux cases PASS, with the hash case taking 33.218 s. `C-NATIVE-51-DEPLOYMENT-CHILD-R5` records one selected Native case PASS in 248.552 s and one test-name deselection, with 137 source inputs/5,597 artifacts stable and no unhandled RPC error in that command. This verification adjustment does not extend product task/lease deadlines or the 30 s resource-reclamation budget, change global Vitest/RPC settings, cache observations, reduce traversal or add a source alias/automatic build. |
| S09 | Links 16/19/26/27: an unconditional non-null receipt assertion does not cover the deliberate unknown-at-return outcome when an actual close is delivered after the cleanup deadline. Three fresh non-injected Native samples each observed a receipt, but do not reconstruct the scheduling behind the historical 172 ms/null observation. A separate deterministic parent-event-loop stall returned unknown, then observed actual SIGKILL close 5.740 ms later while preserving caller cause, `clean: false`, zero tools and zero completion. | `NATIVE-HANDSHAKE-CANCELLATION-SAMPLES-R2-SUMMARY.json` and `NATIVE-HANDSHAKE-STALL-CONTROL-R1-SUMMARY.json` retain their actual loaded-runtime bindings. The original 100 ms cleanup and 600 ms assertion bounds remain; the controlled counterexample is not a fourth unmodified retry. At this addendum boundary, B's exact test-only oracle repair, new control case and independent verification remain Pending. No production cancellation contract was relaxed, and the historical null trigger is not inferred from the new counterexample. |
| U01 | The original packed peer's exit 1 remains UNRESOLVED. A completed durable Session and changed fixture prove business effects, not clean SDK/peer shutdown. The original startup catch did not retain a cause/exit receipt that would locate the failure; later successes cannot supply it. | `C-NATIVE-51-INDEPENDENT-FOCUSED-R2` retains the packed failure; `C-NATIVE-51-PACK-READBACK-R1` binds the original Session. Its completed turn precedes the binding expiry by 116,692 ms, so the record does not support attributing the business phase to the 120 s binding expiry. The later private, finite-stage `C-NATIVE-51-PACK-STAGES-R4.json` observed clean SDK/peer exit but did not reproduce the old failure and is not qualification; R4 is that diagnostic's revision, not a replacement of the original R2 failure. A missing-handshake probe and a changed-template preparation were invalid diagnostic setup, not product PASS/FAIL. Original/private bytes, installation-link witnesses and the independent single-link replacement are retained; no further diagnostic loop is claimed. |

Finding 29 remains **Partial, non-blocking P2**, with an Agent Runtime follow-up
owner after the P0/P1 batch. `PERF29-MEASURE-R2` measured one Linux/WSL `/tmp`
sample as OS user `nobody` (UID/GID 65534): 50 sequential Read authorization and
recording calls took 1,697.257 ms, with 100 source reads, 100 lease reads, zero
network socket/connect calls and no SDK/model/host dispatch. Timings include
`strace` and public loader-observation overhead; no untraced baseline or overhead
estimate exists. Selected source/dist/loaded modules were stable while other
candidate documentation changed, so this is phase evidence, not final-candidate
qualification. The later source read rejected scope drift across an await;
removing independent live checks is not an optimization justified by this sample.
It establishes neither Windows performance, an SLO, universal per-call cost nor
complete optimization. The separate 33–45 s closure observations are not treated
as per-tool authority cost.

The collector declarations, actual executed cases, platform SKIPs and test-name
deselections remain distinct. Any new test declaration requires the next formal
collection rather than a predicted total. This append does not run generators or
change canonical counts. Fresh full-suite/candidate checks, hosted CI and final
independent review remain Pending; real approved-subject/model Windows/WSL
execution and human acceptance remain NotRun. PR #426 remains Draft. No finding
is marked closed merely because this phase addendum was written.

Current scoped review handoff: `PEER-QA-51-CANCELLATION-ORACLE-REVIEW-R1.md`
rates the core oracle repair ADEQUATE, with the later Linux selection recording
17/17 PASS; Native outcomes are owned by B's exact final
`BRIDGE-CANCELLATION-ORACLE-R1-HANDOFF.json`, not inferred from that Linux result.
Failure-only cleanup of the test's process-global diagnostics subscription can
remain incomplete if its bounded close wait itself fails. That residual is a
P2 after-Draft Agent Runtime/QA follow-up, not an implemented change or a blocker
for this batch's scoped core repair. This short handoff leaves S09's earlier
Pending boundary and all historical failures intact; it closes no qualification,
real-model or human-acceptance gate.

## S10 — Shutdown clock-domain repair after f0 hosted validation

Baseline `f0f9b39ffe43c6e39332dc5eaf638f1df2e67c65`, tree
`558ee22bdf0e55a95980cb9e06235b15da9024ce`: the original attempt ended
8 success / 1 Windows failure / 1 tag-only skip, not all green. Its Windows
selection recorded 169 PASS / 2 FAIL / 1 platform SKIP: packed peer exit 1 and
the readonly SDK caller RPC `Invalid owned-resource shutdown deadline`.
The actual default checkout was merge `5e45b9653b240d7db1a0ff9c8bd2122f95393707`
with the same source tree, not the same commit/build metadata. The bot
[CI handoff](https://github.com/Negentropy-Laby/OpenSlack/pull/426#issuecomment-6432089032)
and `CI426-REPAIR51-WINDOWS-FAILURE-R1.json` (SHA-256
`60355dde06914d930a9e68bfd380f9807c7445f07539a0d6ad126db311d0f7ba`)
retain the failures; blocked Windows archive/smoke is NotRun, not the tag skip.

Original paired sender/receiver readings and the exact rejecting predicate are
absent. `CI426-SHUTDOWN-CLOCK-OBSERVATION-R1.json` (SHA-256
`55fcd148d9cc3d3e218beefdb480d31bbc8b3acc64e075b2e280ae539a1ad94a`)
separately observed Native Node 24.18.1: 1,024 samples, 389 old-guard rejections,
with the child reading one millisecond earlier in those rejections. This proves
mechanism reachability, not the original CI cause. Packed exit 1, its relation
to the readonly RPC and historical U01 remain unexplained.

The seven-path repair is exactly `SHUTDOWN-MONOTONIC-DELTA-R2.json`
(2,009 bytes, SHA-256 `45dba723297c34569acc617fe50834ab99b32ab0260e300aca4c4a211b02f746`).
Cleanup uses process-local `performance.now()`; private generation-bound
`remainingMs` is an integer in `1..24000`. The sender retains its original
24-second outer bound; receiver/nested owners, repeated prepare and standard ACK
reuse their first local deadline, with late results rejected. UTC execution/
claim eligibility, actual exit evidence and 25-second grace / 5-second force /
30-second total remain unchanged. No Harness/Aby patch or authority was added.

| Evidence | Actual result and boundary |
| --- | --- |
| `SHUTDOWN-MONOTONIC-SOURCE-R2` | 23 source-level PASS (shutdown 19, connection 4), matching 137-path source snapshot; not built-SDK qualification. |
| `CI426-SHUTDOWN-LINUX-PREP-R1-HANDOFF.json` | Three formal builds and one five-file selection: 40 PASS, zero FAIL/SKIP/unhandled diagnostics; 3,029 sources, 5,597 artifacts and Git/Harness stable. SHA-256 `fcdc6099cb4123f4838227760f717dada58d34c70f2cf70e98b659dedd9c1abf`. |
| `CI426-SHUTDOWN-NATIVE-TARGETED-SUMMARY-R1.json` | Actual Windows: 23 unit/connection + 1 packed + 13 SDK/lifecycle + 1 MCP = 38 distinct file/fullname PASS, duplicates 0. Each group exited 0/null with 3,029 source / 5,597 artifact / Git / Harness stability. The 10/1/29 omitted names are deselections, not platform skips or executed cases. Index SHA-256 `ba86b3d613fff8bc3aafcc2f922034bbc047020f9ab5e56ce96da43667dd1c82`. |
| `PEER-QA-51-SHUTDOWN-MONOTONIC-REVIEW-R1.md` | Independent scoped static sufficiency ADEQUATE, not execution or whole-51 closure. SHA-256 `a8bc34bafc0847584e0eac5fcb67e0b8e470981991ca2c2ea98523a1a5050582`. |

The Native MCP receipt spans 02:48:20.007Z–02:52:47.473Z on 2026-10-27
(selected case 257,119.4674 ms); original task/child/test/cleanup budgets remain.
Native plugin/Harness/callback bindings are separately retained in that index;
Linux callback identity is not substituted. Native task-only public pnpm PATH
and checksum-enforced Go cache preparation corrections preserve their initial
setup/network FAILs; metadata ENOBUFS executed zero cases. No retroactive SDK
receipt, tested TGZ digest, proxy recovery or hosted-cause evidence is invented.

This append preserves the original 37,653-byte ledger prefix, all 51 rows and
S09 history. Accepted ADR-0003 remains unchanged at SHA-256
`90e25063fbea23a4db08b9a6a5dc82ff9129b6558010fd0a7693a10e9878e90b`.
Formal inventory/status collection, a fresh full-candidate run and same-head CI
need their own receipts; 23/40/38 are not summed into a whole-suite result.
U01, the stated nonblocking P2 follow-ups, real approved-subject/model Windows/
WSL execution and human acceptance retain their prior boundaries. #426 remains
open Draft: no approval, merge, release, automatic redispatch or provisioning.


## 2026-11-01: subsequent 45-finding repair

This section is a new review batch with its own numbering 1–45. It does not
replace the 51-finding or R36 records above. The existing Draft PR #426 was
refreshed from `4cdb212a1b111a40269fca78fee6a1fd04574af0`, still targeting
`main@184adb088c6157ceec148061a6b8cef5f8444377`. Repairs remain on the same
`feat/openslack-harness-bridge-20261024` branch, without history rewriting.

The maintainer selected the complete family-port migration and a reviewed MCP
allowlist. Required reviewed tools must be uniquely present with matching schemas;
extra catalog entries are ignored and never registered. No original Harness/Aby
input, credential, identity, production run or deployment is modified. The proposed
business principal is not used as the repair or publishing actor. No live model,
approval, Ready conversion or merge is part of this batch.

### Evidence interpretation

`Implemented` below records a source-level disposition and the named regression,
not final-candidate acceptance. Final full-suite, package and hosted results are
reported for their actual source inputs and head in the update-only PR delivery.
Raw local evidence is retained outside the repository at
`/var/tmp/openslack-pr426-evidence-20261031`; this is not a public attachment claim.
Native records use `D:\Temp\openslack-pr426-repair-20261031`.

The P0 commit is `d53af8a8` (`runtime: preserve committed confirmation and terminal
ownership`). The remaining rows identify their additive commit group: **B**,
Bridge/catalog/resource boundaries; **F**, family/host/read boundaries; **G**,
inventory/CI and canonical projections. The PR delivery maps these group names to
their actual published commits, avoiding a self-referential documentation commit.

- P0 real counterexamples are in `p0-red-real.json` and
  `settlement-production-red.json`; the later expanded P0 run recorded 139 PASS
  and one existing optional-compatibility SKIP. The two settlement setup errors in
  the first RED file are not behavioral counterexamples.
- `disabled-family-red.json` and `disabled-settlement-source-red.json` record the
  actual disabled-family dependency failures before migration. The subsequent
  independent read-only review confirmed optional source closure and the corrected
  stdio startup classification/cleanup through production functions.
- `reused-adapter-old-encoder-red.json` is the controlled old-encoder counterexample:
  the first session succeeds and the next large-message session fails. The earlier
  `reused-adapter-red*.json` fixtures failed before reaching that condition and are
  retained as invalid counterexamples, not regression proof.
- `protocol-vault-red.json` retains strict-JSON/envelope/capacity counterexamples.
  `read-smoke-red.json` retains the old-window omission and unrelated-history
  contradiction. No failures are erased by later passing runs.
- The first ports run had 217 passing assertions but two collection failures caused
  by a missing internal-catalog test alias. The next run had 228 passing assertions
  and eight new fixture setup failures from spying on a frozen service; those
  failures are not production defects. The corrected actual observer matrix passed
  all 17 settlement cases (`settlement-eight-states.json`).
- The first final focused pass recorded 790 PASS/12 existing platform/live SKIP
  (802 declarations). The second recorded 789 PASS/1 FAIL/12 SKIP: a 60-second
  observation test took 70.32 seconds. Independent CPU profiling reproduced the
  timeout and attributed 90.98 seconds to complete runtime closure observation,
  including duplicated fixed approval setup. At that stage only immutable expected
  approval material was shared; workspaces/runs/receipts remained private
  and the four real prepare/accept/inspection phases each reread the executable
  and runtime manifest. An unprofiled independent regression passed with those
  four-read assertions; the earlier timeouts remain retained.
- Whole-delta read-only review additionally reproduced a frozen typed resolver
  error being replaced by TypeError before rejection recording. Two actual launch
  and preflight regressions fail before the repair (`frozen-resolver-origin-red.json`).
  The fix uses the authoritative private origin plus best-effort writable data
  compatibility fields; three selected frozen/mutable cases then pass. Accessor,
  frozen and hostile public properties do not prevent rejection recording.
- The first native focused run recorded 235 PASS/1 FAIL because a fixture Git
  commit treated `/dev/null` as a hooks path. An owned empty fixture hooks directory
  fixes that platform assumption; the original failed real SDK case subsequently
  passed independently (1 selected PASS / 34 name deselections, not 34 platform skips).
  No original Harness or global Git configuration was patched.
- The first native full run used the recorded pre-follow-up source overlay, not
  the final Git candidate: 8,342 PASS/11 FAIL/88 existing platform or opt-in SKIP.
  Its raw JSON and input manifest remain retained. The failures covered stale
  inventory/source-owner assertions, hard-coded shared drive aliases, fixture
  hooks paths, exclusive lock acquisition contention, and an open old state-file
  descriptor preventing Windows replacement. No failed full run is reclassified
  as passing because a focused rerun succeeds.
- The lock repair waits only before any descriptor, ownership record or effect
  exists, within the original monotonic one-second bound. Windows EPERM/EBUSY may
  clear; persistent denial retains its original error. Seven portable cases and
  the actual cross-process contention exercise this boundary. It does not retry
  publication, callbacks, rename, fsync or cleanup. If Windows refuses replacement
  while an old descriptor is open, the test requires the unchanged old state,
  exact retained transaction/intent/temporary bytes and unavailable projection
  even after close. That is a verified indeterminate outcome, not successful
  replacement or automatic recovery. ADR-0004 documents this existing boundary.
- Windows alias fixtures now atomically reserve an unused drive mapping and
  verify the physical target identity before cleanup; they never remove an
  existing unrelated mapping. Source-boundary checks inspect the migrated family
  and host closure, retaining the forbidden-authority lists and negative cases.
- The next native run recorded 139 PASS/4 FAIL/1 existing SKIP; all remaining
  failures were the four pre-SDK observation cases exceeding the unchanged
  60-second case bound. An independent first-case run confirmed the timeout.
  A read-only native measurement of the complete original runtime recorded
  695,675 metadata calls and 27.35 seconds for one capture. No production cache,
  ancestor check, hash phase, timeout, worker limit or retry was relaxed.
  Those tests never start an SDK or model, so they now use the existing complete
  small synthetic installed-runtime fixture builder, with real production
  prepare/cutoff/accept/inspect readers, actual Node and built plugin proofs,
  four fresh phase reads, private mutable run evidence, and an explicit zero-peer
  assertion for every case. Original SDK composition and linked/packed process
  integration tests remain separate and unchanged. The failed native case then
  passed independently; all eight previously failing files passed together:
  143 PASS/0 FAIL/1 existing platform SKIP. This proves the focused behavior,
  not original-SDK performance or a final whole-suite result.
- Official Linux Node 24.18.1, Bun 1.4.0 and Go 1.26.5 build the external plugin.
  Original Harness remains pinned to `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`;
  its actual Linux and native-Windows artifact/check commands passed, with no
  original source patch. Original tracked/index/ref preservation is checked
  separately from generated artifacts.
- Actual Windows handle tests passed under the pinned Node 24.18.1 PATH:
  `native-supervisor-pinned24.log`. Cross-compilation is not substituted for those
  native waits, cancellation and zero-execution creation-failure observations.
- Full typecheck and contract-family checks passed. Earlier no-checkout and
  with-checkout collections agreed at 8,747 declarations/589 files; the resolver
  regression phase then recorded 8,749/589. After the native follow-ups, the
  production collector records 8,757 declarations/590 files. Two actual generation
  passes produce identical canonical/projection bytes. These are declaration
  inventories, not execution pass counts. ESLint's one unused fixture import was
  removed and the corrected run reports zero errors and zero warnings. The source-lock
  intersection covers 32 source/contract manifests and is empty; no digest,
  binding set or authority scope is widened.
- A minimum-version Node 22.0.0 test attempt stopped before collection because
  the existing main lock already uses Vite 7's ESM loader contract. It ran zero
  cases and proves no compatibility outcome. Node 22 LTS ordinary execution and
  pinned Node 24 Harness execution are recorded separately; the product engines
  declaration and dependency lock are not changed to hide that tooling limit.
  The official Node 22.23.4 LTS ordinary boundary run subsequently passed 44/44.
- Frozen `9f2efc71` initially recorded two focused passes of 898 PASS/0 FAIL/19
  existing SKIP, followed by 897 PASS/1 FAIL/19 SKIP. The real paused-pipe case
  returned cancellation with no timely close receipt under its original 100 ms
  cleanup bound. Its independent rerun passed; neither observation erases the
  failure. The old unconditional non-null assertion conflicted with the existing
  explicitly unconfirmed cleanup contract already tested beside it. The repaired
  matrix uses the same exact public child observer: every receipt must match the
  real exit/close; null requires a spent original budget, no observed close, and
  `{exit:null,clean:false}`. A separate bounded late-close observation cannot
  upgrade that returned failure. Post-wait uniqueness, primary cause identity,
  exit-before-close and zero-effect assertions remain mandatory. An added actual
  paused-pipe/parent-stall case deterministically covers this branch. No production
  behavior, cleanup/test timeout, worker count, retry or platform skip changed.
  The full corrected cancellation file passes 21/21. The previous attempted
  triple is not a successful three-pass acceptance record.
  Native Windows independently passes the same 21/21 cases. The production
  inventory now records 8,758 declarations/590 files; two subsequent generation
  passes are byte-identical. The running native full `9f2efc71` receipt and its
  separate MCP CLI confirmation failure remain retained; a selected-case PASS
  and an eight-case independent file PASS do not close that full-run failure.

### Native full-run follow-up and preserved uncertainty

- Frozen `45c04134` completed three consecutive affected runs of 913 PASS /
  0 FAIL / 19 existing SKIP, then full Linux 8,733 PASS / 0 FAIL / 25 SKIP.
  These results remain tied to that exact candidate, not later edits.
- The clean native Windows `9f2efc71` full run completed, rather than hung:
  8,361 PASS / 2 FAIL / 88 SKIP. Its long-running real Workflow effect-boundary
  file passed. Neither worker count nor test timeout was changed. One failure
  was an authority audit-journal rename returning EPERM; the other was an MCP
  CLI positive confirmation returning blocked. Independent selected-case and
  whole-file passes are retained without erasing either full-run failure or
  attributing the second failure to the first. The CLI assertion now includes
  only bounded status/blocker codes; its strict completed/result check remains.
- Two real service-path RED regressions explicitly refuse the policy or journal
  rename once. The same existing Windows publication policy is now reused for
  these files: one fixed one-second budget, only refused rename retried, fresh
  prepared-directory, temporary and original-target checks before each attempt.
  Bytes are written and fsynced once. Directory fsync and readback are not
  retried, and no HTTP request, confirmation or executor is replayed.
- The 19-case authority chain passes. It covers EPERM/EACCES/EBUSY for both
  publication roles, persistent refusal, source/target replacement, a rename
  that moved its inode before reporting failure, synchronization failure and
  primary-plus-cleanup errors. Terminal-response-loss paths still execute once,
  send one completion mutation, retain durable remote succeeded/uncertainty,
  refuse a duplicate confirmation and leave the local fallback store empty.
- Independent read-only review found an avoidable cleanup observation gap in
  the first follow-up. Its controlled old-order counterexample deletes foreign
  replacement bytes and fails. The corrected cleanup verifies all directories
  before the final temporary-inode observation, immediately preceding removal;
  the same regression retains the replacement and primary failure. No recovery
  format, RunStore indeterminate-publication policy or authority is changed.
- The production collector records 8,771 declarations/590 files after these
  regressions. Repeated generation and final candidate acceptance are recorded
  separately. The 32 existing source/contract manifests have an empty changed
  path intersection, including the two operator implementation files; their
  digests, binding sets and scope are unchanged. New-head Linux/native full
  validation remains required; no existing result is relabelled as that run.

### Startup observation follow-up

- Frozen `14e680f0` broadened the affected set to 68 files and recorded
  1,062 PASS / 1 FAIL / 19 SKIP in its first run. The failure was the old
  short authority fixture requiring one spawn observation; it observed zero.
  Its independent rerun passed. Neither result establishes the exact cause
  of the original failure or permits calling that attempted triple successful.
- Production starts its deadline before synchronous recorder persistence, so
  exhausting the original 100 ms budget before child construction is reachable.
  A controlled 120 ms recorder stall proves this without renewing that budget.
  The corrected oracle requires raw construction count, spawn matches and
  pending candidates all zero, a timeout after at least 100 ms, zero authority
  calls, no tool/result/completion and a null receipt. Zero spawn matches alone
  never establish this outcome. The constructed-child branch retains exact
  executable/argv/PID binding and actual close observation; later close cannot
  upgrade the returned refusal or its cleanup evidence.
- Two additional ordinary-setup cases require actual entry into rejected and
  never-settling authority ports. The latter queues a controlled deadline abort
  inside the entered callback. Both require exactly one authority call, bounded
  public diagnostics, no effects/completion and owned close. These are distinct
  from startup-cutoff coverage; the existing 100 ms test and cleanup budgets,
  worker profile and outer observation limits are unchanged.
- Independent read-only review found and corrected an await-window gap in the
  test observer itself: uniqueness and pending checks must also hold after close
  observation and before returning a root to recursive fixture cleanup. An inert
  callback-only regression injects a second construction during that wait; it
  rejects and preserves the workspace. It spawns no OS process and supplies no
  native qualification evidence. The complete corrected file passes 44/44;
  the first type-check and inert-counterexample implementation failures remain.
- Native `14e680f0` formal build, 48 former-failure cases and the 8,771-case
  inventory passed. Its full run was stopped as an obsolete candidate after
  the Linux failure; it has no full-suite PASS. Raw cancellation and independent
  process readback are retained. A new candidate must receive fresh full Linux
  and native validation. The production collector now records 8,775 declarations
  in 590 files; repeated generation and final acceptance remain separate receipts.

### Transcript and paired-writer follow-up

- Frozen `206b3b92` passed its first expanded affected run, then recorded
  1,065 PASS / 2 FAIL / 19 SKIP in its second. The failures were the original
  five-second oversized-event case and pre-acquisition RUN_STATE_BUSY in the
  two-process writer fixture. Both independently passed afterward; those passes
  do not replace the failed acceptance attempt.
- A deterministic work counter proves the reader's repeated-prefix cost:
  the existing 9 MiB case measured 693,601,717 string bytes scanned. The reader
  now decodes each complete 64 KiB block once with the same persistent fatal
  decoder, scans only that new chunk, counts each new fragment and joins once
  per completed record. It preserves 64 MiB/file and 16 MiB/event limits,
  file-leading BOM semantics, block-wide invalid-UTF8 rejection before visits,
  strict JSON, final-LF checks and the stable descriptor boundary. No duration
  threshold is used. The existing case adds split-multibyte and later-BOM
  checks; the invalid-UTF8 case requires zero callbacks for a valid row followed
  by bad bytes in the same block.
- The run lock deliberately promises a bounded wait, not greedy-writer fairness.
  The fixture now releases both ready OS writers once per round and waits for
  both durable acknowledgements before the next round. It sends no retry and
  replays no callback. Final assertions retain 20 tool increments, 20 reports
  and all 40 distinct role/round events. IPC/exit failure stops owned children;
  both normal and after-test cleanup observe their close before deleting roots.
  Existing bounded-busy and indeterminate-publication tests remain intact.
- The 33-case file passes after these changes. Production lock/test deadlines,
  default workers, authority, event schema and durable format are unchanged.
  The transcript source is absent from all 32 existing source-lock manifests;
  no binding or authority scope is expanded. The next acceptance record must
  identify its actual uncommitted inputs or frozen SHA; it cannot inherit a
  successful triple from the earlier candidate.

### Canonical-creation observation follow-up

- The first transcript working-input acceptance attempt recorded 1,066 PASS /
  1 FAIL / 19 SKIP. The real two-host publication case observed
  RUN_INITIALIZATION_INCOMPLETE after a stale absence probe. Both selected
  process cases subsequently passed independently; no successful triple is
  inferred. A deterministic interleave then reproduced the production error
  using one real createRun publisher and a stale ENOENT observation.
- Before classifying leftover metadata as orphan evidence, the missing-canonical
  branch now verifies its protected directories and re-observes maintenance,
  foreign ownership and canonical arrival. Publication evolution yields the
  existing same-run SnapshotChanged observation. A genuinely incomplete orphan
  still fails; no bytes are repaired, created, accepted unvalidated or replayed,
  and no retry bound or private owned-read restriction changes. The regression
  checks Changed then ready, one publisher only, and preserved orphan metadata.
  The complete state/host pair passes 63 cases.
- Native `206b3b92` full execution finished with 8,380 PASS / 1 FAIL / 88 SKIP.
  Its sole failure was the actual SDK composition case exceeding its original
  300-second outer test budget; that budget was not expanded. An independent
  same-source execution passed the case in 177.83 seconds (34 other cases
  deselected, not platform skips). The retained full-run fixture reached
  completed/verified in about 90 seconds within its own unchanged task window;
  this does not turn the failed outer test into PASS or establish its exact
  timing cause. Final platform suites are scheduled separately with their
  unchanged default worker profiles and all original test/runtime deadlines.
- The initial targeted invocation after the source edit stopped before collection
  because its formal compatibility witness was stale. That is a retained
  zero-case preparation failure. The ordinary package invocation passes 63/63;
  complete compatibility acceptance requires fresh explicit preparation and a
  new input-bound result.

### Ordinary Node 22 and disjoint Python execution follow-up

- The read-race working inputs completed three affected passes, each 1,068 PASS /
  0 FAIL / 19 SKIP. Their recorded input manifest is
  `5ff9b92ea98064afa244986a93bc58d316c1dc8c20ef3204877ce77d3bad7747`;
  these are uncommitted-input results, not executions of a later frozen commit.
- The subsequent ordinary Node 22.23.4 full run, without a Harness checkout,
  recorded 8,588 PASS / 3 FAIL / 21 SKIP. Two fixture expectations assumed the
  qualified Node 24.18.1 path, although production correctly refused the local
  Node identity earlier. Those cases now assert the real unsupported-runtime
  refusal and lack of execution artifacts on ordinary Node, while retaining the
  original missing-artifact and nested-drift assertions on qualified Node.
  The production runtime pin, product engines and execution gates are unchanged.
- The third failure was the administrator Python wrapper exceeding its existing
  five-second test budget. It ran portable cases once and then repeated them in
  the all-platform invocation. The private test runner now selects disjoint
  portable and Linux groups. Measured discovery is 6 portable plus 41 Linux =
  47 total; each group and the unchanged all selector executes its entire
  selected set with zero skipped cases. Conflicting selectors refuse. Native
  non-Linux execution retains actual zero-I/O CLI refusal checks. No timeout,
  worker count, retry or production administrator entrypoint changes.
- The three affected files pass independently on both Node 22.23.4 and
  24.18.1: 75 PASS / 0 FAIL / 3 existing platform SKIP each. This does not erase
  the earlier failed full run or establish final whole-suite acceptance.
- The subsequent complete 69-file affected set passed three consecutive times:
  each 1,080 PASS / 0 FAIL / 19 existing SKIP. Ordinary Node 22.23.4, without
  an external Harness checkout, then passed the complete ordinary suite:
  8,591 PASS / 0 FAIL / 21 existing SKIP, ending 2026-10-31T21:50:05Z.
  Those receipts share uncommitted input collection
  `afa3422416874ef9997ac9d42580dc76ee4772f295c2f4a426ce3e1f7ceedd8e`.
  Independent static review found no concrete blocker in the eight-file delta;
  its captured bytes and the later committed mapping remain separate from
  runtime execution, native qualification and human approval.
- The production inventory subsequently collected 8,776 declared cases in
  590 files, including platform/opt-in declarations. Count, status and document
  generation ran twice; the second pass produced no new differences. These
  declarations are not a count of executed cases or overall qualification.

### All 45 dispositions

`AR` means `packages/agent-runtime/src`; `MCP` means `apps/mcp/src`; `Plugin`
means `integrations/deepseek-harness`. Portable behavior, Linux-only I/O, native
Windows execution and opt-in real-model work remain distinct evidence classes.

| # | Original finding | Priority | Disposition and behavioral evidence | Commit / platform |
| --- | --- | --- | --- | --- |
| 1 | Late abort misclassifies committed confirmation | P0 | Consume the trusted returned record. Real composition confirms durable success despite late abort; no second execute or false stop. | d53af8a8; portable |
| 2 | One transient settlement read kills admission | P0 | Success performs no readback. Failure observation retries only known transient contention; unresolved state holds without replay. Real composition and observer matrix cover both paths. | d53af8a8; portable |
| 3 | Long timeout becomes a 1 ms timer | P0 | Segment delays at 2^31−1 while preserving the absolute and monotonic budget; reject unrepresentable dates before admission. Host boundary regression covers long deadlines. | d53af8a8; portable |
| 4 | Read failure publishes a late stop on completed run | P0 | Stop/fail use the canonical run transaction and owner generation; completed state is a no-op and uncertainty does not publish a guessed stop fact. Completed/stop and lock regressions remain. | d53af8a8; portable + actual file transactions |
| 5 | Close while Windows wait is outstanding | P0 | A cancellable waiter owns a separate SYNCHRONIZE duplicate and closes it after its wait returns. Native cancellation/exit tests pass. | d53af8a8; native Windows |
| 6 | Job handle closed twice in failure hook | P1 | Corrected attribution: the private hook caused the old ownership violation. Inject an independent invalid association parameter without closing the production-owned Job. Real creation failure executes no child. | d53af8a8; native Windows |
| 7 | Zero token budget omitted | P0 | Only null is unbounded. Preserve zero and negative constrained values; request payload matrix retains the distinction. | d53af8a8; portable |
| 8 | Three immediate snapshot retries exhaust contention budget | P0 | Synchronous read remains one observation. Waiting production paths use the bounded asynchronous snapshot wait within the remaining task deadline. Cross-process lock regression retained. | d53af8a8; actual file transactions |
| 9 | Corrupt stop file escapes bounded read taxonomy | P0 | Return bounded unavailable/corrupt projection; retain the file, no raw JSON exception or automatic replay. Corrupt-stop regression covers it. | d53af8a8; portable |
| 10 | Active run disappears beyond event window | P1 | Resolve the same visible run anchor separately from feed-window trimming. Old active run is visible, while invisible/other-run anchors grant nothing. | F; portable |
| 11 | Directory count hard-codes 12/16 | P1 | Use the host-owned reviewed names/schemas, reject missing/duplicate required tools, ignore extras. Actual MCP fixture advertises an extra unreviewed tool without exposing it. | B; portable + actual SDK process |
| 12 | Inventory requires an external checkout | P1 | Collect lazy declarations without SDK imports or a witness. Actual no-checkout and with-checkout production collections agree. Execution still requires the real dependency. | G; portable |
| 13 | Smoke loses trusted failure/run association | P1 | Use host-recorded error origin, including non-extensible errors; never scan for the latest run or trust an arbitrary runId property. Existing launcher rejection/hostile-error regressions verify origin. | F; portable |
| 14 | Unrelated storage lock makes a PASS report contain FAIL | P1 | Inspect only this invocation's run. Its unavailable required evidence makes the whole report FAIL; unrelated locked history does not. Actual smoke positive/negative fixture covers this. | F; portable |
| 15 | Main gates lost Node 22 coverage | P1 | Add ordinary Node 22 OpenSlack jobs to both existing workflows; retain pinned Node 24 Harness qualification, original required names/permissions and product engines. | G; hosted Node 22 + local pinned probe |
| 16 | Strict result JSON leaks SyntaxError/upstream text | P1 | Emit fixed PeerFailure(PROTOCOL), no cause/model sentinel and no complete frame. Real receiver regression covers malformed strict JSON. | B; portable |
| 17 | Reused adapter retains previous chunk identity | P1 | Reset encoder/decoder per session and guard callbacks by their child instance. Controlled old-encoder counterexample proves the second large-message session boundary. | B; portable process fixture |
| 18 | Direct receiver skips envelope validation | P1 | Both entrypoints validate before payload/SDK access. Invalid version/envelope rejects with the same typed failure and zero SDK start. | B; portable |
| 19 | Witness ordering depends on locale | P1 | Sort final witness paths by explicit UTF-8 bytes, not localeCompare. Preserve old reports; new inputs receive new witnesses. | B; Bun/Node tooling |
| 20 | Workflow/executor family keys disagree | P1 | Separate sealed workflow, executor and adapter indexes. A test-only unequal-ID family previews, binds, confirms and executes; collisions/swaps reject. | F; portable |
| 21 | Disabled family source is always read | P1 | Enabled family factories own their source closure and optional settlement observer. Three disabled-Harness source tripwires verify no read. | F; portable |
| 22 | Repeated live tool authorization reads | P2 | Retain independent task/principal/lease checks across awaits and effects; do not memoize authorization. Freshness/permission drift negatives are retained. This is a cost observation, not a proven authorization defect. | F; retained safety boundary |
| 23 | Compile each glob for each path | P2 | Compile the allow/deny matchers once per fresh task capture, then apply them to each path. No cross-call permission cache. | F; portable |
| 24 | Source cache still walks the tree | P2 | Retain independent source membership/stamp checks at admission/effect stages; they detect added/replaced files and do not claim a zero-I/O cache. Avoid unsafe long-lived cached authorization. | retained safety boundary; AR source drift tests |
| 25 | Repeated dispatch authorization/rebind | P2 | Preserve before/after preparation and acceptance authorization and canonical CAS rebinds. These are different await/effect boundaries, not one permanently immutable authorization result. | retained safety boundary; host drift tests |
| 26 | Windows polls Job-empty during normal execution | P2 | Start the Job-empty ticker only on closing, retaining original cleanup deadlines and observed exit requirements. | d53af8a8; native Windows |
| 27 | Vault grows without a bound | P1 | Sweep expired entries and reserve before the first await; cap pending plus in-flight previews at 128. Capacity refuses before upstream and does not evict live capabilities. | B; portable concurrent/expiry regressions |
| 28 | Family-specific branches scattered through composition | P1 | Complete GovernedWorkflowFamily ports own restoration, authorization, observation, compile, execute and optional settlement; both existing families migrate. Direct Scenario remains separate. | F; portable actual composition |
| 29 | Settlement inference is not exhaustive | P1 | One exhaustive union covers all eight persisted states; unknown reads hold. The real production observer is used by tests, including returned versus uncertain succeeded records. | d53af8a8 + F; portable |
| 30 | Harness guards copied across composition | P1 | Each family owns its authorization and the sealed registry calls it at binding/execution boundaries; front/shared paths do not duplicate Harness-name predicates. | F; portable |
| 31 | Git change-name logic copied twice | P2 | Execution and reconciliation share one change-name reader, while independent acceptance/reconciliation observations remain. | F; Git fixture |
| 32 | Unconsumed public runtime-entry helper | P2 | Remove only the new unpublished no-consumer helper and its barrel export. Keep the actual verified deployment entry mapping. | F; build/typecheck |
| 33 | Repeated completion checks | P2 | Retain stop/lease/CAS checks around the host revalidation callback and each store publication boundary. A synchronous host hook can invalidate evidence; reduction is not a gate. | retained safety boundary; host mutation/stop tests |
| 34 | Write/Edit handlers repeat the same guard sequence | P2 | One generic handler preserves actor, live authorization, path, expiry and preview ordering; typed wrappers retain their distinct native intent semantics. | B; actual SDK file fixtures |
| 35 | Owner-source exclusivity expressed as boolean algebra | P2 | Use the package-owned three-source selection list and cardinality check; all conflicting pairs reject before composition. | F; CLI/package tests |
| 36 | Eligibility aliases reparse owned values | P2 | Own frozen parsed restrictions privately; reuse structure validation only for owned values and recheck expiry at live boundaries. Raw input still validates independently. | B; expiry/foreign-object tests |
| 37 | Call-ID regex copies have different semantics | P1 | Share SDK call-ID semantics only. Task/report business references retain their own intentional character sets; different concepts are not unified. | B; corrected attribution |
| 38 | Startup frame cap duplicates the wire limit | P1 | Consume the pure Bridge frame-limit contract in startup. Chunk/message bounds remain separately enforced. | B; wire/process negatives |
| 39 | Private parseFrame duplicates decoder | P1 | Remove the test-only parser; tests exercise the actual bounded Bridge decoder and receiver. | B; portable |
| 40 | Vault repeats RUN-ID grammar | P1 | Consume canonical RUN_ID_RE through the controlled pure Bridge leaf; packed declarations include that leaf's run-id dependency. | B; build/packed consumer |
| 41 | Read-side binding validation appears to diverge | P1 | Corrected attribution:32 is per report,128 cumulative state. Separate shared validators preserve both, including completed⇒verified. Boundary matrix rejects33/129 in the corresponding contexts. | F; portable |
| 42 | Coupled derived readiness booleans | P2 | A single ready/unavailable Scenario result supplies definitions; registered family entries supply workflow readiness. No claim of a proven authorization bypass. | F; portable |
| 43 | repair-run missing from command authority | P1 | Register the existing command in modules.yaml and generate its status projection; no new top-level command. | G; status verification |
| 44 | ADR-0004 absent from ADR index | P1 | Add its existing Accepted decision to the index and source list. This is navigation synchronization, not a new approval decision. | G; docs verification |
| 45 | CLI owns Harness selection and server lifecycle | P1 | MCP package owns selection, canonical root, principal/profile gates and stdio lifecycle. CLI parses/wires signals/renders only; startup failure drains exactly once with accurate phase. | F; real transport failure + CLI signals |

### Remaining acceptance boundary

Required final validation remains mandatory on the repaired source: three consecutive
focused passes, full Linux and native Windows, independent plugin build, actual saved
TGZ install/smoke, full typecheck/build/lint0/0, applicable Go/contract checks,
workspace/golden/Genesis/docs/status, unchanged original dependency witnesses,
independent read-only review and synchronized head CI/PRMS. Pending evidence is not
substituted by old green CI, a deselected case, cross-compilation or a source-only
review. Real integration identity/deployment/model and human approval are separate.


### Publication follow-up: bounded GitHub App JWT clock margin

The normal-clock authentication failure was traced to the JWT expiry boundary,
not an invalid key. The Windows clock was approximately 14 seconds ahead of the
GitHub HTTPS response time. With the previous `exp = localNow + 600`, GitHub
rejected the JWT as too far in the future. A diagnostic-only 30-second local
clock control, using the same configured key and verified TLS endpoint, obtained
HTTP 200 for the existing App/repository installation. Normal-clock rejection
was then reproduced independently. These diagnostic controls did not change the
system clock, mint a publication token, or publish any Git mutation.

The approved minimal production change uses `exp = localNow + 540`, retaining
`iat = localNow - 60`, RS256, the configured App issuer, repository resolution
and all existing permission and credential boundaries. It tolerates up to 60
seconds of a fast clock; it does not claim to correct arbitrary clock skew or
replace authentication validation. No key replacement, NTP/proxy configuration,
credential copying, human-token fallback or new public API is part of this fix.

Four new behavioral regressions failed against the old implementation: clocks
14, 59 and 60 seconds ahead exceeded the independently defined server expiry
limit, and both real serialized installation-discovery/token-request JWTs used
the overlong expiry. The same tests check the actual signature and unchanged
issuer/header. The corrected implementation passed all five affected auth and
delivery suites three consecutive times: 81 PASS / 0 FAIL / 0 SKIP each. Synthetic
test keys and an offline HTTP boundary are separate from the configured bot key.
The same five suites also pass on ordinary Node 22.23.4: 81/81. Independent
read-only review found no concrete blocker in the two-file change or candidate
implementation/original-configuration routing. That reviewer did not execute
tests, use the configured key, authenticate, or make an approval decision.
The production collector measured 8,780 declared cases in 590 files. Two full
count/status/document-generation passes produced identical second-pass bytes.
The 32 existing source-lock manifests have no intersection with this follow-up
and remain byte-identical; no binding set or authority scope is changed.

The previous frozen `ade64e10` full Linux/native Windows and artifact results
remain historical evidence; they do not validate these changed source bytes.
Final source validation, normal-clock configured-bot authentication, update-only
publication to #426 and current-head CI/PRMS are recorded separately after they
actually execute. Publication loads the candidate authentication implementation
with the original approved configuration root; it does not copy credentials
into a new checkout. The PR remains Draft, with no approval, merge, deployment,
real-model task or identity bootstrap authorized by this follow-up.


### Native final-run follow-up: incumbent lock retirement

The frozen `12ad0a80` Linux run passed 8,755 cases with 25 existing skips, but
its native Windows full run failed: 8,384 PASS, 2 FAIL, 88 SKIP. The failures were
an approval-store concurrent decision that surfaced an OS error instead of CAS,
and an MCP concurrent confirmation that surfaced READ_PROJECTION_FAILED.
A subsequent unmodified two-file pass did not close those full-run failures.
All original full-run and diagnostic outputs remain in the external batch.

Fresh isolated diagnostic races retained exactly one executor/decision winner,
one completed result and the winning canonical final record before checking
loser classifications. They captured approval incumbent `open` EPERM. A complete
Node filesystem trace captured plan-lock `realpath` EBADF overlapping the
incumbent's successful unlink; a separate bounded observer located PATH_UNSAFE
at incumbent path resolution. The original full run did not capture those raw
causes, so its individual failures are not retroactively assigned a syscall.
A rebuilt native consumer also captured EPERM specifically from realpath. A
further old-guard regression failed both changed-incumbent EBADF/EPERM cases
(51 PASS / 2 FAIL); neither error grants ownership of a replacement.
These observations do not justify classifying arbitrary storage errors as a
successful or active mutation, nor ignoring EBADF from fsync or close.

The approval acquisition loop now permits its existing exclusive acquisition
retry for Windows EPERM only after independently verifying that the incumbent
is absent. A present incumbent, EACCES and a failed verification remain errors. Its
resolved-path mismatch also retries only after separately proving disappearance;
a present mismatched path remains unsafe. Three additional real-writer cases
failed twice on the old guard (24 PASS / 2 FAIL) and pass all 26 cases after the
change, including the stable-incumbent and verification-refusal negatives.
The plan-store read localizes Windows EBADF/EPERM handling to realpath of an
incumbent; verified absence or changed exact identity/stamps becomes FILE_CHANGED. A mismatched resolved path becomes
FILE_CHANGED only after verifying disappearance or a changed exact identity or
stamp. A stable mismatch remains PATH_UNSAFE. The next attempt still needs a
fresh non-overwriting exclusive link and record CAS; observation never grants
ownership of another writer's lock. No new retry count, worker limit, timeout,
MCP error-classification exception or native directory-sync exception is added.

Regressions hold a real writer at its record replacement, retire its incumbent,
then exercise the contender at the exact open/realpath boundary. They require
one canonical winning publication, a new exclusive acquisition before CAS
refusal, and unchanged live locks/records on negative paths. The old native
approval implementation failed one of 23 cases; the guard passed all 23. The
old native plan implementation failed five of 49 cases; the guard passed all
49. Two additional all-platform tests cover changed-stamp/mismatched resolution
and failure of the follow-up metadata read. The ordinary approval race now
compares actual bytes with the fulfilled winner and counts record replacements,
replacing its former self-comparison. A separate Linux run exposed a fixture
clock mismatch: real binding issuance could occur after the store's fixed
`now + 1s` decision time while awaiting disk I/O. The synchronous test binding
helper now fixes Date only during issuance and restores it before returning;
filesystem timers, production checks and all timeouts remain unchanged.

Diagnostic setup mistakes are retained separately: an attempted spy on a frozen
prototype was refused, and a diagnostic assertion initially compared a string
with a Buffer. Native MCP diagnostic runs made before rebuilding its consumed
package dist still exercised old operator output, despite copied source files;
they cannot validate or refute the new implementation. Build source/output
hashes must accompany the rebuilt-consumer check. Controlled repetitions and
fault injection are diagnostic experiments, not test retries or qualification.
A subsequent native ordinary eight-file pass retained two unchanged owner-only
operation timeouts (5s/10s) and another approval PATH_UNSAFE result. Timeout
limits and workers were not relaxed. Unexplained no-executor errors from two
earlier diagnostic repetitions are also retained; they did not justify broader
authorization or error-handling exceptions. The rebuilt operator consumer then
passed all 60 independent hundred-confirmation diagnostic races (79 total cases),
with the original exactly-once and canonical terminal-result checks.
Final current-source full Linux/native Windows, generated counts, artifact
binding, independent review and synchronized head CI remain separate gates.

The final working source passed all eight affected suites three consecutive
runs on both Linux and native Windows: 180 PASS / 0 FAIL / 0 SKIP per run.
Those are precommit runs, not executions retroactively assigned a later SHA.
Native current bytes were compared after the runs; no older input manifest is
used as their pre-run attestation. The clean frozen candidate must rerun them.
The collector measured 8,797 declarations in 590 files; final status/docs
regeneration ran twice with identical second-pass output. All 32 existing
source-lock manifests remain byte-identical with no changed-path intersection.
Independent read-only review found no concrete blocker in the seven-path delta;
it did not run tests, authenticate or originate approval.

An overlapping Linux focused run also retained one existing 5,000ms bot-auth
fixture timeout. Final verification is scheduled after collection/build jobs,
using unchanged default workers, timeouts and assertions. These later passes
do not erase the failed logs or establish an unsampled historical root cause.
No hosted PASS, frozen package qualification, live model result, approval or
merge is inferred from this working-source evidence.


### Frozen fc7d1b39 full-run counterexamples and protocol-refusal oracle

The clean frozen `fc7d1b39` run retained 8,767 PASS / 5 FAIL / 25 SKIP across
590 files, exit 1. Four cases exceeded their unchanged 30s/5s/5s/90s bounds:
notification order-decision history, cleanup fixture setting confirmation,
Workflow shadow-hook inventory and the runtime-delivery verifier profile.
Native formal compilation overlapped the early portion of this run. The logs
do not establish a shared root cause. All four unmodified suites subsequently
passed 104/104 in an isolated control without parallel compilation, retaining
all history, durability, post-confirmation revalidation, verifier branches and
absolute deadlines. This control does not turn the original full run green.

The fifth case exposed a confirmed test-oracle error: after rejecting a foreign
run frame, it required process exit code 0. Production bounded cleanup may
legitimately terminate that same peer. A controlled peer kept alive after the
foreign frame deterministically failed the old assertion (one FAIL, one PASS).
The corrected natural/held-open pair observes the exact real child, preserves
`envelope_malformed` and the original another-run reason, and checks zero tool
calls, no successful result or completion progress, and no completed state.
It compares a known returned receipt with the owned child's actual close.
An unknown returned receipt stays null/unconfirmed after separately observing
late close; teardown cannot supply the observation used to pass the assertions.
No production logic, exit grace, timeout, worker count or protocol rule changes.
The full affected Bridge suite passed three consecutive Linux runs, 45/45 each.

An intervening nine-file working run retained one legacy UTF-8 case that reached
its original 2s execution cutoff before the expected malformed-envelope result
(224 PASS / 1 FAIL). It was not accepted as protocol coverage, and its deadline
was not relaxed. A new frozen full run is required; earlier full failures and
unexplained timing observations remain separate evidence.

The same 45-case suite subsequently passed three consecutive native Windows
runs with an exact source/baseline input record written before execution.
The full production collector measured 8,798 declarations in 590 files after
the additional held-open case; generated module/status projections accompany
this test-only change. Source-lock membership and all 32 manifest bytes remain
unchanged. Read-only review found no blocker in the owned-child oracle, actual
failure/completion progress assertions, or unknown-at-return handling. This is
not an approval decision or final whole-suite qualification.

The copied native driver incorrectly labeled `productionChanged: true` in its
working receipts. A separate metadata correction binds the retained originals
by SHA256 and identifies comparison to `fc7d1b39` as test-only (plus count/docs
projections); no production logic changed in this oracle follow-up. The original
receipts and raw three-run outcomes are preserved, not silently rewritten.


### Confirmed dual active-confirmation replies; current full evidence stays open

The clean `8e937713` local Linux full run retained 8,753 PASS / 20 FAIL /
25 SKIP and one Vitest onTaskUpdate RPC timeout. Nineteen assertions exceeded
existing deadlines. The remaining assertion observed the legitimate returned
executing-record blocker `GOVERNED_MUTATION_EXECUTION_ACTIVE` while accepting
only the service-refusal blocker `GOVERNED_PLAN_EXECUTION_ACTIVE`.
Production already supports both paths. The narrow assertion now accepts exactly
these two values, retaining blocked status, one executor invocation, one completed
response, durable succeeded state and every result-schema check. Generic
READ_PROJECTION_FAILED, uncertain storage errors and other blockers still fail.
No production behavior, public classification, timeout, worker or retry changes.
The original failing full result is the red evidence; both Linux and native
Windows then passed the unchanged 20-case suite three consecutive times.
Inventory remains 8,798 declarations in 590 files; this changes no test count.

All individual independent quality commands on the preceding head returned 0,
including ordinary Node22, typecheck/build and ESLint0/0. The final clean-source
assertion failed after this intentional working test edit; that command sequence
is retained as modified-source evidence, not relabeled as final qualification.
New frozen checks remain necessary. The prior full failures and unsampled causes
are not cleared by targeted passes, and no source fix is invented for deadlines.

Normal-clock configured authentication, installation-token acquisition and the
actual bot branch push succeeded without key replacement, clock adjustment or
human-token fallback. A stopped progress attempt was reconciled against the
unchanged remote before retry. The published thirteen-commit head was explicitly
WIP / acceptance=false and remained Draft; this follow-up updates that same PR.
Progress publication does not waive full current-head CI, native/artifact checks,
PRMS, independent review or later human/CODEOWNER approval. No deployment,
identity bootstrap, model task, approval or merge was performed.


### Recovery-fixture clock follow-up after the e638ece6 native full run

The frozen e638ece6 native Windows full run returned **8,399 passed / 5 failed /
88 skipped** in 590 files. Preserve that result. Three failures hit their existing
300-second closed-loop, 120-second effect-shadow, and 10-second absent-store
bounds. The other two were actual `WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID`
exceptions in prepared-decision recovery fixtures: the store used the fixture's
fixed clock, while synchronous human-binding issuance used later wall time.
Their fixture-relative 30-second binding windows had elapsed during real Windows
ACL/file operations. Production correctly refused those stale inputs.

The two recovery tests now explicitly select the same fixed observation window.
A private helper freezes **Date only** around the three synchronous issuance
calls and restores real time in `finally` before any filesystem await. Issued-at
assertions bind each result to the injected store clock. Production code, grant
TTL/expiry checks, distinct repair nonces, the original committed attestation
nonce, and live/dead-owner recovery assertions are unchanged. This does not
accept expired real authorization or freeze task deadlines.

Deterministic RED evidence changes the fixture window before changing issuance:
the old calls produce the same two real binding-invalid exceptions (two failed,
30 filtered cases), rather than an import or missing-module failure. GREEN on
Linux runs the full file three times: each has **31 passed / 0 failed / 1 existing
Windows-only skip**. Native Windows executes the two changed cases three times: **2 passed / 0
failed** each, with 30 other cases filtered each time. A separate ordinary Node
22 run of the whole file has **31 passed / 0 failed / 1 existing platform skip**.
Typecheck and ESLint pass. Filtered diagnostics do not count as a complete
Windows-suite pass. The production inventory collector and status/docs generators
ran twice without an additional diff; 8,798 declarations in 590 files remain
unchanged. No test declaration count was added.

For the retained e638ece6 candidate, all 12 applicable hosted checks passed; the
PR-only tag-publication job was correctly skipped. Hosted complete Linux Tests
reported **8,773 passed / 0 failed / 25 skipped** on synthetic merge dea1efe6,
whose tree exactly matches candidate c262615d. The local Linux result remains
**8,772 passed / 1 timeout / 25 skipped**. The hosted native closed-loop scope
passed 227 cases plus one existing skip; its configured-host case took 140.6
seconds. In the separate local native full, that case completed all assertions
and left a `completed / verified` task, but its 502-second total still failed the
original 300-second bound. Do not relabel either local full result as passed.

Both actual saved Linux/Windows TGZs passed installed-SDK smoke and inspection
of all 38 members. Their unpacked payload digest is identical; preserve each
original archive digest rather than reconstructing an archive. Source/artifact
integrity remains separate from complete test acceptance. All 32 source-lock
manifests and their binding sets remain unchanged, with no hit for this test.

Independent read-only review found no concrete blocker in this fixture-only
change and verified finally restoration, the three-call scope, and retention of
production expiry and recovery semantics. It did not run tests or decide
approval. Append the repair to the same Draft #426; current-head CI/whole-run
acceptance must be evaluated again. Do not widen bounds, lower workers, add
retries or suppressions, or use the old head's green checks as the new result.


### 2026-11-01: 38-finding repair, source acceptance pending

This is an additive repair of Draft #426 on its existing branch, beginning at
`b526be6d`. The first storage/authorization fixes are in `49abdd82`; follow-up
commits retain the same PR and public formats. Prior 51/R36/45 dispositions and
all failed runs above remain history. No approval, merge, deployment, production
repair or real-model qualification is established by this section.

The maintainer explicitly delegated setup of this repair context. The existing
active `anthropic_architect_aby` registry is unchanged; a new CLI runtime record
uses no key and copies no previous identity. Task `TASK-2026-426038` records this
human delegation and the actual path intersection, not a GitHub claim or lease.
Neither the #425 identity nor the candidate business principal is substituted.
New package references and the workspace lock change only declare the selected
pure Core leaf dependency; no external dependency version is expanded.

The retained baseline behavior failed all six correctness regressions. Further
independent review identified two per-file recovery-headroom gaps and the real
peer/worker recorder contention path; their behavioral RED results are retained.
The shared recovery encoder now reserves actual snapshot expansion and a
separate transcript maintenance tail before ordinary publication. Known legacy
exhaustion is refused before barrier/archive publication. No evidence is trimmed.

| Finding | Disposition and necessary boundary | Regression or retained proof |
| --- | --- | --- |
| 1 | Fixed: bounded acceptance is included in inspection, CAS and byte archive; never promotes completion. | `run-review38` crashes before completion and after terminal commit, then authorizes real archival. |
| 2 | Fixed: one charged 96 MiB budget replaces the unrelated 4096-member cap; 94 MiB ordinary ceiling and recovery/terminal headroom. | `run-capacity`, `run-review38` >4096-chain actual crash/archive, `run-recovery-boundary` near-limit recovery. |
| 3 | Fixed: exact local two-link publication pairs locate the original route without synchronous spin or automatic replay. | `harness-state-repair`, `harness-task-host`, `run-review38`; foreign links still refuse. |
| 4 | Fixed: requested missing run is FAIL; CLI prints missing and exits nonzero. | `run-review38`, CLI `agent-runtime` production-result command test. |
| 5 | Fixed: smoke required checks and aggregate status agree; only this invocation's run is read. | `run-review38`, `openai-compatible-diagnostics`. |
| 6 | Fixed: synchronous busy is immediate; async boundaries wait only on unopened-lock refusal, never after callback/effect. | `run-ownership-lock`, `run-wait`, `recorder-availability`, actual peer + independent writer in `harness-bridge`. |
| 7 | Guarded: rejected and verified acceptance both validate task/request/principal/owner inside the transaction. No prior reachable exploit is claimed. | Both replacement-generation negative cases in `harness-state-repair`. |
| 8 | Fixed: invocation ownership precedes shared mutation; finally closes only its own session. | Real overlapping peer regression in `harness-bridge`, plus session-close/exit cases. |
| 9 | Fixed: progress uses exported bounded async snapshot observation. Persistent locks remain strict reconciliation failures. | Short writer and retained-lock cases in `workflow-progress-strict`. |
| 10 | Fixed: OpenAI smoke failure attribution uses host-owned identity, never a caller's raw runId. | Immutable foreign runId case in `openai-compatible-diagnostics`. |
| 11 | Compatibility retained: the real wire decoder was already strict; no demonstrated peer break warrants changing the protocol version. | Existing Bridge envelope/wire acceptance and actual external-peer tests remain mandatory. |
| 12 | Fixed: internal persistence cause survives; public error text remains bounded and excludes the cause. | `run-capacity` cause sentinel and existing retirement-error precedence tests. |
| 13 | Simplified: remove only the extra initial accepted-byte check; retain both actual publication boundaries. | Two-call positive counter plus genuine final-CAS drift negative in `harness-state-repair`. |
| 14 | Fixed with #5: smoke no longer enumerates unrelated history. | Unrelated retained-lock smoke regression. |
| 15 | Simplified: 5/10/20/40/50 ms bounded async backoff, single monotonic budget and cancellation. | `run-wait` counts, delayed wake, absolute cutoff and cancellation. |
| 16 | Shared: plugin uses the existing Bridge version authority. | Bridge contract and real peer tests; no wire version change. |
| 17 | Shared: `isCode` handles missing/error classification at the affected owned paths. | Deployment/runtime-closure/stop negative cases. |
| 18 | Shared: strict repair consumes the same transcript parser, with additional durable timestamp/newline/secret rules. | Transcript, repair and >8 MiB full-evidence tests. |
| 19 | Shared: canonical run directory helpers own layout. | Store, ownership and repair round trips and missing observations. |
| 20 | Shared: owned JSON uses strict UTF-8/duplicate-key/depth decoding; third-party package.json compatibility is retained deliberately. | Duplicate-key snapshot plus existing deployment/closure parsing negatives. |
| 21 | Simplified: remove private stop/report/source delegates without deleting public APIs. | Host, report and source-drift suites. |
| 22 | Simplified: calculate policy once in the prerequisite boundary and reuse it; reject diagnostics remain. | Launcher and provider-registry suites. |
| 23 | Shared: activity and display window use one cutoff function; visibility anchors remain independent. | MCP context/activity visibility and old-active-run cases. |
| 24 | Shared: capture one execution row and consume the frozen unavailable-reason authority. | MCP projection/result-schema and runtime observation suites. |
| 25 | Shared: lexical anti-alias and resolved-path equality remain distinct functions. | Explicit Windows/POSIX path matrix; native alias/observer cases. |
| 26 | Shared: MCP, Qoder and plugin consume the same confirmation grammar through a pure leaf. | Core grammar bounds, Qoder result schema and plugin confirmation cases. |
| 27 | Internal clock port added; default remains real UTC. No claim to fix clock skew or renew authority. | Independent host/peer clocks at expiry and invalid-clock boundaries. |
| 28 | Finite-clock denial retained in shared logic; no unreachable-production or clock-safety claim. | Single-sample clock counters and malformed-clock negatives. |
| 29 | Named pending confirmation limit remains exactly 128 and independent of evidence limits. | Core fixed-value assertion and Vault capacity/expiry cases. |
| 30 | Simplified: observation uses the strict capture once and preserves explicit missing/locked/unsafe outcomes. | Store and R36 observation tests. |
| 31 | Safety boundary retained: fresh deployment bytes are rehashed independently across prepare/execute/accept. Only owned same-stage data is reused. | Phase-local observation counters and execute/accept drift negatives. |
| 32 | Simplified: callback-time freshness compares captured byte digests; fresh state and metadata reads remain. | Both callback-time drift cases in `run-capacity`; R36 independent-writer tests. |
| 33 | Corrected attribution: one PowerShell already queries PID and OS. Keep independent probes across barrier/CAS; no ineffective merge. | Process-witness and real maintenance crash cases; native proof still required. |
| 34 | Shared: wait defaults/cutoffs are derived once; caller cancellation and independent UTC bounds remain. | `run-wait`, task authority and host contention/cutoff cases. |
| 35 | Shared: startup and host use reviewed bounded descriptor mechanics with nanosecond identity; purpose policy stays local. | Core owned-file failure/close cases, plugin binding negatives and packed relocation. |
| 36 | Shared: host/peer eligibility restriction type, shape and expiry; trusted clocks are in-process only. | Host startup eligibility and peer scope-evidence matrices. |
| 37 | Fixed: register SUBST ownership immediately; post-allocation failures release only a still-matching local mapping. | Four portable failure/ownership cases and required actual Windows alias fixtures. |
| 38 | Governance gate, not code defect: keep Draft and require independent review, current CI/PRMS and later human/CODEOWNER approval. | Live #426 metadata; bot never approves or converts Ready in this task. |

Working evidence is retained outside the repository in
`/var/tmp/openslack-pr426-review38-20261101-88tleiux`. It is local source-bound
evidence, not an uploaded CI artifact. The first expanded runs exposed missing
plugin test aliases and legacy fixtures expecting synchronous contention waits;
both were corrected to the production async pre-acquisition boundary. All
original at-most-once, durable acknowledgement and rejection assertions remain.
A new 64 MiB archive assertion initially used deep object equality, exhausting a
Vitest worker heap; exact Buffer byte comparison replaces that assertion without
changing limits or reducing byte coverage. The failed run remains recorded.
The >4096-file archive initially hit its 20-second bound under load. File fsync,
full readback and source CAS stay mandatory; same-stage duplicate copies and
hashes were removed. No timeout, worker, retry, skip or memory setting was raised.

Final three-run, whole-platform, Node22, package, generated-count/lock, hosted CI
and independent-review acceptance must be recorded for the resulting source.
This section does not use the b526 green results to prove new bytes.


The new asynchronous recorder boundary also has a controlled RED for the host
cutoff immediately after durable authorization-attempt recording. The scripted
peer initially performed its marker effect despite the host subsequently
reporting timeout. The repaired host rechecks immediately before an allowed
response and again when those captured bytes leave the outbound queue; the
full 22-case eligibility file then passed with zero marker effect in that case.
No new wire field, permission, TTL, retry or completion-grace extension is used.


The first frozen expanded run on 40f0376f reported 1082 passed, one timeout and 11
existing skips. The timeout was the new long-history test's combined synthetic
construction, inspection, crash-input preparation and actual archival, not a
failed recovery assertion. The existing 20-second archival bound is unchanged.
Its synthetic history and abandoned-writer input now use the normal bounded
fixture hook; any preparation assertion/hook timeout fails the suite. The test
still performs one complete authorized repair, checks the resulting canonical
state and all 4098 archived intents, with every fsync/readback/CAS intact. No
retry, skip, worker, production deadline or memory limit was changed.
