---
schema: openslack.document.v1
id: qa-ledger-harness-pr426-2026-10-27
status: In Review
authority: index
audience:
  - contributors
  - reviewers
owner: qa
updated: 2026-10-27
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
