---
schema: openslack.document.v1
id: qa-ledger-harness-r36-2026-10-28
status: In Review
authority: index
audience:
  - contributors
  - reviewers
owner: qa
updated: 2026-10-28
sources:
  - docs/architecture/adr/adr-0003-harness-closed-loop-repair.md
  - docs/architecture/adr/adr-0004-run-storage-recovery.md
  - production/qa/qa-ledger-harness-pr426-2026-10-27.md
---

# PR #426: R36 repair and verification ledger

## Identity, authority and meaning

This is a new ledger, not a revision of the original 51-finding history. R36-01
through R36-36 refer only to the later 36-item review of head
`9f33f17a7ed4bfd9ec8956894440dd7c4e7a3d8d`, tree
`16aabfc7e08b5b53435a2a14dde1769f380314e4`, base
`184adb088c6157ceec148061a6b8cef5f8444377`. Delivery receipts below identify
appended commits; that starting SHA never identifies dirty inputs.
Only the existing `feat/openslack-harness-bridge-20261024` / Draft PR #426 may be
updated. No new PR, Harness patch, identity, policy expansion, task replay,
production historical-data repair, cleanup, approval, merge or release is authorized.

The maintainer formally accepted the exact ADR-0004 Proposed bytes (14,430;
SHA-256 `286f411c97d85bb00201e35bdd36736625e0bff557b7afd2ebbc144a2c1b1bce`).
The retained Proposed copy and acceptance provenance are described in ADR-0004.
The maintenance host port used by unit fixtures is synthetic, not an approved
subject, production authorizer or grant to repair a real run. The stock CLI has
no write authority. UTC task/claim lease expiry remains a separate policy cutoff;
local elapsed/wait/cleanup timers use monotonic time.

## Evidence records and categories

Raw local records append under
`.openslack.local/harness-evidence/20261024/repair-426-20261026T0756Z-gg9PtI/r36-20261028`.
Local presence is not public attachment publication. Node is 24.18.1, Bun 1.4.0,
Go 1.26.5. The dependency remains original Harness
`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`, SDK/dsh 0.2.1-rc.3 / MCP 2.2.0.
Linux/WSL tests are not native Windows results or real-model acceptance.

- **Measured RED:** baseline list poisoning, partial creation and public append
  TOCTOU reproduced using preserved exact 9f33 files (`baseline/`,
  `storage-red.mjs`). One initial missing-Core setup failure remains distinct.
- **Measured RED:** new post-commit lease expiry test observed 2,048 reserved
  bytes instead of zero before the receipt repair. No tool had been dispatched.
- **Measured GREEN, phase only:** 57 storage/recovery cases across
  `run-storage-r36.test.ts` and `run-repair.test.ts`, including two real processes
  in both create/append orders, writer crash windows, maintenance-process crashes,
  predecessor-proof negatives, archive/FD/directory CAS rejection and byte-preserved
  committed results. This is not 57 findings or a final-candidate result.
- **Measured GREEN, phase only:** 52 state/evidence/Bridge-eligibility cases; 36
  MCP family/activity cases with one existing skip; 40 CLI startup/repair cases;
  6 catalog/connection cases; 21 streaming/shutdown cases; 4 actual SDK lifecycle
  cases. Later full-package reports supersede none of these historical timestamps.
- **Independent static code review:** storage specialist second pass APPROVE on
  the six storage/recovery modules. TD's repeated pre-effect reservation finding
  and the later resolver/monotonic-cutoff gap were repaired and independently
  re-reviewed APPROVE. A separate consumer review found lost query binding after
  durable confirmation and the smoke command's historical-failure fallback; both
  were repaired and re-reviewed. These are code reviews, not test or CI results.
- **Independent static QA:** the requested predecessor-edge, byte-preservation,
  pre-intent fsync, CAS, bounded teardown and OS-port negatives were added.
  Final scoped QA is APPROVED WITH SUGGESTIONS; the isolated mock reset and native
  Windows test correction were separately re-reviewed. Simulated PID reuse/CIM
  branches are not actual PID reuse or native permission failures.
- **Preserved full-package phases:** `plugin-r1.json` has 124 PASS, 1 FAIL,
  9 SKIP; `agent-runtime-r1.json` has 729 PASS, 2 FAIL, 13 SKIP. Their precise
  causes were a raw-source child import and two wall-clock elapsed test oracles.
  Subsequent r2 reports have plugin 128 PASS/9 SKIP and runtime 740 PASS/13 SKIP.
  Plugin r3 has 138 PASS/9 SKIP after the durable query-binding regression.
- **Preserved nonprivileged full phase:** fresh locked installation under the
  existing nobody OS account copied no identity, credential, dependency or dist.
  `/tmp/openslack-r36-validation-lNybxl/full-default-r1.json` records 8,462 PASS,
  6 FAIL, 19 SKIP. The six were traced to stripped HOME, a root-owned shared temp
  lock directory, structural-error classification and unprepared Go module/cache
  networking. No timeout/assertion was widened. With actual account HOME, isolated
  TMPDIR/GOPATH, verified downloads and nominal error mapping, the six-file
  `failed-six-r4.json` phase has 73 PASS/1 SKIP. At that checkpoint a new full
  compatibility run was pending; focused results do not replace the failed run.
- **Native Windows phase:** fresh frozen install and formal emission under Node
  24.18.1 succeeded. Seven focused files record 138 PASS, 1 FAIL, 6 SKIP in
  `D:/Users/WSMAN/Desktop/Coding Task/.openslack-r36-native-SPH5NN/focused.json`.
  The sole failure attempted a directory rename prevented by Windows' live-FD
  policy. The revised test proves exact rename EPERM, unchanged directory identity
  and original bytes, retained barrier and unavailable observation; `repair-r2.json`
  records all 37 repair cases PASS. Linux separately proves replacement actually
  completes before CAS rejection. This is not a claim of native replacement-after-CAS.
- **Preparation counterexample:** formal force-emission without official schema
  staging was invalidated by later typecheck staging four original schema bytes.
  Formal prepare now runs the existing staging step before binding outputs, binds
  its script/contracts inputs, rejects fixture redirection, and keeps Go version
  inspection local. Initial stale-inventory failures remain failures; at that
  checkpoint complete collection and idempotent status generation were pending.
- **Measured trace:** one warm Linux synthetic tool sequence (reservation, first
  authorization, two exact rechecks, observed call and complete result) made 16
  fsync calls: 8 ownership, 3 intent, 2 transcript, 3 checkpoint, 46.273 ms.
  A no-change transaction made one ownership fsync, no intent/transcript/checkpoint
  writes, 3.014 ms; canonical bytes were identical. This is not cold Windows
  latency or the complete live authorization/tool loop. P2 measurements continue.

## Single-item disposition

`AR` means `packages/agent-runtime/src`; `Plugin` means
`integrations/deepseek-harness`; `MCP` means `apps/mcp/src`.
Implemented is not independently reviewed, qualified, delivered or accepted.

| ID | Priority / necessity | Current action and evidence; remaining exit |
| --- | --- | --- |
| R36-01 | P0: orphan locks must not poison all observations. | Shared `run-ownership.ts`; strict reads still refuse unresolved locks. `RunObservation`/per-entry listing isolate unavailable runs. ADR-0004 nominal inspection + explicit fixture-only repair archives and proves owner death before retirement. Storage/recovery and recorded full Linux inputs GREEN; native recovery subset is separately recorded below, not full Windows qualification. |
| R36-02 | P0: creation cannot mix owners or overwrite partial publication. | Common ownership, v2 creation/metadata/transaction identities, fsynced immutable intents, exclusive metadata then canonical publication. Crash windows classify proven safe failure or unavailable; no automatic rollback/replay. Real two-process ordering and partial-publication tests. |
| R36-03 | P1: reclaim only provably undispatched capacity. | `recorder.ts` opaque process-private receipt; prepared/authorization_attempted/settled/not_dispatched. Original new owner alone may reclaim; attempted/legacy/foreign receipts retain capacity. Lease RED/GREEN, repeated pre-effect checks and independent correction review pass; plugin r3 passes. |
| R36-04 | P0: public append must share create/update ownership. | `transcript.ts` delegates to the common store owner before checking canonical existence; append and watermark publish together. Legacy-only bytes prohibit same-ID create. Baseline RED; deterministic two-process GREEN. |
| R36-05 | P1: persistence faults cannot hide the provider failure. | Launcher preserves primary cause/run ID with bounded nonsecret secondary diagnostics, including initialization, Aby reserve/settlement/usage. Reused-ID and double persistence failure regressions pass. Smoke cannot substitute a historical run for a new failure. |
| R36-06 | P1: local clock jumps must not renew elapsed budgets. | Bridge/startup/owned-host local timers use first `performance.now()` deadlines; explicit UTC lease/task limits remain independent denial bounds. Wall-clock/local-budget regressions pass in the full Linux and scoped native phases; neither renews policy leases. |
| R36-07 | P1: close during start needs real facts. | Immediate public non-lazy SDK close, no initialize wait or fictional pid -1 for attempted startup; observer stays until close settlement. Four actual SDK fixture cases phase GREEN. No claim of inevitable leakage from the fixed SDK. |
| R36-08 | P1: finite caller read budget must be honored. | Explicit `{waitMs,signal}`, one monotonic deadline, default 1 s, longer finite waits honored, Infinity rejected. Real 1.25 s writer/2.5 s budget GREEN. |
| R36-09 | P1: corrupt/mismatched records cannot hide healthy records. | Ready/missing/unavailable observations, healthy ordering and unavailable entries survive untrusted filters; CLI/MCP/TUI diagnostics surface availability instead of empty success. Mixed-record and MCP activity tests. |
| R36-10 | P1: observation and authorization have different availability semantics. | Visible-anchor-only activity and reconciliation use explicit availability. Workflow maps only nominal invalid-state/snapshot-conflict errors to local-invalid/reconciliation diagnostics; strict reads still reject, non-strict reads never reuse a locked snapshot. New strict/non-strict byte-preservation regression passes; worker bootstrap stays strict. |
| R36-11 | P1: catalog pages cannot exceed startup budget. | Connect/all tools-list pages/ready share one monotonic deadline, timeout+signal and outer bound; no reconnect. Real delayed/paginated server RED then 6-case phase GREEN. |
| R36-12 | P1: published admission must not lose its owner on unlink failure. | Explicit publication-unconfirmed handoff keeps route owner; host records stop/non-executable failure and reports indeterminate, never normal pending. Exact admission-unlink regression passes in the full Linux inputs. |
| R36-13 | P2: preserve policy is intentional, not unnoticed cleanup permission. | Keep trusted provider policy and safe external default; no restoration of destructive cleanup. `docs/architecture/components/agent-runtime.md` documents embedding-host migration; provider-registry and launcher-policy regressions pass in the full Linux inputs. |
| R36-14 | P1: durable confirmation plus failed observer is not unexecuted confirm. | Single settlement path; typed immutable durable record and stable settlement-unconfirmed MCP outcome. Nine sync/async/combined-failure tests pass; vault binds only exact durable dispatch query route and rejects changed plan/task/action/state/blocker/settlement. No new execution or replay grant. |
| R36-15 | P1: already-open LLM streams must stop forwarding. | Per-chunk closing/eligibility guard using `for await`, IteratorClose on rejection. Mid-stream close/expiry RED then 21-case phase GREEN. |
| R36-16 | P1: keep link rejection but expose safe actionable diagnosis. | Typed `HARNESS_ROOT_UNSAFE`, safe physical-path guidance through CLI, no raw OS path/cause and no junction allowance. CLI regression phase GREEN. |
| R36-17 | Contract: fixed public dependency layout is deliberate. | `runtime-public.mjs` validates exact approved MCP 2.2.0 root/stdio export layout and gives explicit compatibility-upgrade refusal, not guessed private resolution. Actual public-package build and version/string-export/missing-types/default negatives pass in the full Linux inputs. No general dependency-layout resolver is required. |
| R36-18 | P1: startup interruption is not proof of prior service. | Separate everServed/closeRequested; one safe error renderer. SIGINT/SIGTERM-before-start and EOF phase tests GREEN. |
| R36-19 | P2: optimize measured work without delaying confirmed evidence. | No-change checks skip intent/transcript/checkpoint publication; required ownership, scanning and confirmed-event fsync remain. The scoped warm Linux trace above is measured, not inherited 6-transaction/full-loop evidence. No delayed flush window or unproven durability relaxation was introduced. |
| R36-20 | P2: cache bytes, never authority. | Retain synchronous phase-local opaque reuse. Independent storage review found no immutable/exclusive-writer witness that would make a metadata hit a cross-stage byte proof; do not implement that unsafe optimization. Fresh per-stage body reads remain. Extended open-writer regression passes on Linux/Windows; it is not an identical-metadata counterexample or measured performance fix. |
| R36-21 | P2: CI must share preparation without hiding qualification. | Both entries call one minimal `scripts/ci/prepare-harness-deps.sh`; fixed source/index/ref guards, frozen install and both original builds remain unconditional. OS/SHA/lock/tool-delimited cache contains only the integrity-checked download store. Cross-platform syntax/parity regressions and exact scoped TD review pass. Actual new-head hosted preparation remains required. |
| R36-22 | P2: absence optimization cannot conceal unsafe/denied reads. | Reject proposed `existsSync` shortcut. A missing leaf behind a real linked/junction ancestor is rejected on Linux/Windows while original stop bytes remain intact. No new coalescing platform or cached stop authority is necessary; retain the live protected read. |
| R36-23 | P1: shared stable bytes with RunStore precision. | `run-files.ts` wraps Core stable descriptor bytes and retains caller directory policy plus bigint/nanosecond FD/entry checks. No portable fixture authorizer is used. Storage/link/CAS phase GREEN. |
| R36-24 | P1: MCP and host storage policy must not diverge. | Export/reuse `assertHarnessRunStorage` through the internal host barrel; MCP private traversal removed. Unsafe paths still fail closed; visible unavailable output separately tested. |
| R36-25 | P1: one cleanup contract, not ineffective knobs. | Pure wire leaf owns 24 s owned /25 s grace /5 s force /30 s total constants; host/plugin/provider reserve it. Legacy Harness exitGraceMs values other than 30000 reject explicitly. Configuration negatives and Linux artifact/Bridge regressions pass; native keyless SDK/process subset passes separately. |
| R36-26 | P1: one resolver classification must govern the whole path. | Resolve the sealed persisted Workflow target, not Scenario executor ID; one family used for both permission and definition path. Unsupported targets do not fall back. Wrong worker/initiator target and Scenario regressions GREEN. |
| R36-27 | P1: roles must come from trusted composition. | Required frozen worker(runId)/initiator discriminator in vault; host derives one validated frozen role and publishes targets from it. Model/observation cannot mint it. Role-confusion negatives and scoped independent consumer review pass. |
| R36-28 | P1: avoid allocating the maximum for every tiny state. | Core byte reader allocates actual descriptor size; bounded guard retained. Shared strict-read/full Linux regressions pass. This is not a measured heap/GC throughput improvement claim. |
| R36-29 | P2: no test-only second authorization entrance. | Removed `releaseConfirmedAdmission`; test uses real plan/execution/attempt settlement. Host/state phase tests GREEN. |
| R36-30 | P2: one production settlement path. | Removed unused `onConfirmed` option/notification; tests exercise `onConfirmationSettled`. Phase hook tests GREEN. |
| R36-31 | P2: one rebind expression, same live await ordering. | Private `rebind` retains state read then fresh task read and bound-state check at each await boundary. No cached task authority. Host suite phase GREEN. |
| R36-32 | P2: one errno discriminator. | `io-errors.ts` reused by store/ownership/host/admission/witness; path policies remain with callers. Build phase GREEN. |
| R36-33 | P2: correct diagnostic, preserve historical grammar. | Message describes actual `^RUN-[A-Z0-9-]+$`; no narrowing. Short RUN-A/RUN--, long historical IDs and exact invalid-ID diagnostic regression pass; long-ID MCP projection test retained. |
| R36-34 | Contract: inventory is complete, not a lite estimate. | Full inventory still requires prepared original dependency and now a current content witness. Default root no-checkout mode remains independent. Preparation command documented; no implicit build/skip/lite mode. |
| R36-35 | P1: built-output tests must reject stale dist. | `prepare-compatibility.mjs` force-emits, builds, then binds source/config/lock/tool/dependency/output hashes. Both internal aliases use built outputs. Config validates only; preserved-mtime source/lock/config/output/compiler/peer drift test GREEN. |
| R36-36 | P1: exercise the exact candidate policy without provisioning. | Real candidate YAML + exact before-LF fixture through parse/glob/authorization; exact path/two actions allow, neighbor/protected/Red/Black/approve/merge deny. Synthetic snapshot is not production subject; missing identity production resolver still rejects. Eleven phase cases GREEN. |

## Exit criteria and outstanding owners

### Additive local delivery phase

The first source batches are `796812558a23ceb6d72623d0ae1f2126fc2550db`,
`3105789116e86ee2e7dd227c5e5b71a8ab912362` and
`a9bd768a2175ebad894a3e24f026e419240ec6b8`. None rewrites the published 9f33
history. Backup ref `backup/pr426-r36-20261028-9f33f17a` retains that starting
commit. Local commits alone are not a push, PR-head synchronization or CI receipt.

- Fresh native `focused-r3.json` now records **139 PASS/6 SKIP in seven files**;
  the preceding 1-FAIL result remains retained. This subset includes actual SDK
  shutdown/process behavior, Windows witness branches and fixture-only recovery.
- Complete nonprivileged compatibility r2 is **8,593 PASS/19 FAIL/25 SKIP**.
  Eighteen failures identify missing pnpm on the selected PATH; the nineteenth is
  npm's unwritable default cache under the actual nobody home. After the precise
  tool-path/independent-cache correction, the five-file phase has 48 PASS/1 FAIL:
  the remaining fixture still declared the obsolete 10 s cleanup configuration.
  It now consumes the shared 30 s contract, preserving its existing 240 s task
  budget and all assertions. Its actual SDK → governed admission → worker →
  native files/report → independent acceptance → original caller verified-readback
  case passed in 50.52 s (`live-keyless-r4.json`, **1 PASS/29 unselected**).
  This is keyless synthetic-principal integration, not real-model qualification.
- Complete collection in both the repair root and the nonprivileged copy found
  **8,637 declared cases in 585 files**. The later no-update collection verifies
  those counts. Two official status generations preserve exactly:
  `.openslack/modules.yaml` SHA-256
  `cf993ae7d47e33669527949f3515e03982a3f07ccb1006f204b8abaa95074902` and
  `docs/status/current.md` SHA-256
  `778415d4ea3aa224d98f9d5695391000857dac177d594af0e1f4e2b664fb24d1`.
  Status verify passes. These are inventory/generation results, not a test pass count.
- Formal preparation also builds the existing fixed ignored worker bundle, without
  changing or running frozen Worker/Broker code. Otherwise full tests lazily add
  that output and rightly invalidate the preparation witness. Actual before/after
  comparison found that bundle as the sole output difference; this is not an
  explanation for the 19 installation failures. Independent TD approved the fixed
  build-only call and complete source/import binding. Both current Linux roots
  emitted the same 3,182,515-byte bundle SHA-256
  `384c44b7bbdce015195c7bf344e208b94ab3575ef35dace4b3c01140a10a3892`.
- Full typecheck and all contract-family exact-byte checks passed; lint passed
  with only the existing module-type notice. Workspace, docs verify/migration,
  notification docs, Genesis (5/5) and golden (7/7) checks passed. Two read-only
  governance renders matched each other and the existing four projections, with
  zero projection writes. At this checkpoint the complete compatibility run and
  hosted CI were still pending; later results below retain their own timestamps.

The original Windows authentication workspace's package-owned bot entry was
verified against the existing bot-author open Draft #426, matching ref/repository
and base, no auto-merge. The delivery clone was clean at 9f33 for the preflight.
Publication and subsequent P2 decisions have separate receipts below; U01, live
subject/model and human acceptance remain independently outstanding.

### Published checkpoint and subsequent P2 scope

The configured bot published through the existing package-owned Git transport.
At `2026-10-28T10:24:50Z`, the local delivery branch, remote branch, PR head and
`refs/pull/426/head` all read back
`4bf6224450038d6f3f89a473c298b7964fb26049` (tree
`f138ce23c14e99654f79e5695507d8d35072cc62`). PR #426 remained open Draft,
base `184adb088c6157ceec148061a6b8cef5f8444377`, auto-merge disabled.
`publication-4bf6224450038d6f3f89a473c298b7964fb26049.json` records that receipt;
the existing bot checkpoint comment is
<https://github.com/Negentropy-Laby/OpenSlack/pull/426#issuecomment-6466675999>.

- **Complete Linux compatibility r3:** `full-compat-r3.json` / `.log` records
  **8,612 PASS / 0 FAIL / 25 SKIP in 585 files**, from `10:18:14.966Z` through
  `10:33:06.680Z`. It ran Vitest's body with `--maxWorkers=2`, actual nobody
  uid 65534/HOME `/nonexistent`, Python 3.12.9, qualified Git and isolated caches.
  The validation copy's Git HEAD was 9f33 plus exact copied changes, not 4bf.
  `candidate-4bf-input-equivalence.json` compares all 89 changed paths: 88 match;
  only this non-executed QA prose differed after the run began. This post-run
  changed-path comparison supports 4bf source equivalence under the recorded copy
  provenance; it is not a run-start full-tree/environment snapshot. Do not relabel
  the old copy's Git HEAD or reuse it as a later candidate's full-run receipt.
- **P2 local regressions:** Linux `p2-focused.json` has **60 PASS / 2 platform
  SKIP**; native `p2-regressions.json` has **62 PASS / 0 SKIP**, covering the same
  three files. Independent scoped QA verified byte identity and assertion scope.
  The writer-open test compares new body hashes before closing its writer. Native
  observed same size but changed mtime/ctime; it does not prove an identical-stat
  cache hit. Linux's JSON does not retain those console fields. Node documents
  platform-dependent time precision, and Windows only guarantees correct file
  times after the modifying handle closes; metadata equality is not made new
  deployment authority. See [Node stat times](https://nodejs.org/download/release/v24.18.0/docs/api/fs.html#stat-time-values)
  and [Microsoft file times](https://learn.microsoft.com/en-us/windows/win32/sysinfo/file-times).
- **Shared preparation:** scoped TD review APPROVE covers the exact helper,
  two workflows, README and parity test. GitHub can return primary-key prefix
  matches even without restore keys; the delimited key is not an exact-only
  promise. Cache data never becomes an executable output or authority snapshot.
  A task-owned empty fixture used actual pnpm 11.28.5 with frozen/offline install,
  `--side-effects-cache=false --verify-store-integrity=true`; it succeeded without
  changing the fixture package or lock. This verifies those public flags, not a
  successful fresh 1,418-package CDN download or hosted cache restore.
- **New storage trace:** `storage-trace-p2-20261028T112801Z.json` preserves actual
  stdout at `11:28:01.420Z`, Node 24.18.1/Linux uid 0, separate synthetic fixture.
  The same scoped sequence has 16 fsyncs (8 ownership/3 intent/2 transcript/3
  checkpoint), 42.278565 ms; no-op has one ownership fsync, no other publication,
  2.527452 ms and unchanged checkpoint bytes/revision. The earlier 46.273/3.014 ms
  figures remain historical tool-transcript observations, not this raw receipt.
  Neither run measures native Windows, a full live tool loop or deadline headroom.
- **R4 and source binding:** the subsequent complete run has **8,612 PASS /
  0 FAIL / 25 SKIP**, 585 files, from `11:18:48.963Z` to `11:27:17.421Z`.
  `full-compat-r4.json` SHA-256 is
  `00d65f04f6a7cc602ed0bd3a9fe1fb932633ff4dbca4e33b2d5f70bc0e93f5d5`.
  A post-run comparison of all **3,051 tracked blobs** against code candidate
  `de043746dc253e3a9d65f2a826912c3966c89c13` found two differences: QA prose and
  validation-only `go.work.sum`, expanded by earlier dependency preparation.
  No module manifest or implementation/test body differed. The expanded file
  adds 162 checksum lines, removes none, and includes two version keys absent
  from the original checksum file; do not call it byte-identical candidate input.
  `candidate-de043-r4-all-tracked-comparison-red.json` preserves that finding.
  The sum file is backed up outside the clone; only this task-owned validation
  copy is restored to the candidate's original bytes for a final pre-bound run.
  Main-checkout Go files remain unchanged and are not delivery candidates.
  The final run and new-head CI must receive their own receipts.

The P2 source/regression batch is `46adb877afc0951cccbddc1e2ae38fa10d3e3d04`;
shared dependency preparation is `de043746dc253e3a9d65f2a826912c3966c89c13`.
Both are additive commits after 4bf. Final local typecheck/contract-family checks,
lint, docs verify/migration, workspace and notification-doc checks passed. A
complete 8,637-case inventory verification and two official status generations
again preserve the exact registry/status hashes above. Two read-only renders
match all four governance projections with zero projection writes. Scoped TD,
storage and QA reviewers approved these exact code/test/document boundaries;
their verdicts are not GitHub APPROVE or a final hosted qualification result.

### Hosted failures and read-only evidence boundary at 4bf

At `11:11:06.947Z`, bot-authenticated checks still bound to 4bf. Self Validate
run `40671917353` failed at upstream locked installation: SheetJS's fixed
`xlsx-0.20.3.tgz` returned HTTP 503, then a fetch timeout, then 503. OpenSlack
build/tests were not reached in that job. The raw job `122761005177` log is
retained, not replaced by a later HTTP-200 probe. No lock, version, TLS or
integrity bypass is allowed. Download caching does not itself fix that incident.

Release run `40671917331`, Windows job `122760558997`, passed original dependency,
typecheck, plugin build and supervisor verification, then had **201 PASS / 1 FAIL
/ 1 SKIP in 14 files**. The real SDK governed closed loop itself passed; the sole
failure was the first snapshot-observation fixture's 5-second task deadline
inside initial admission, before its snapshot assertions. A bounded first-use
Windows OS witness is a possible contributor, not measured directly in that CI
log. An isolated native diagnostic injects a 5,020 ms OS-port timeout: unprepared
admission produces the same denial; explicit preparation then completes the
unchanged 5-second task. Both diagnostic cases pass. The host suite now prepares
the real bounded OS port in `beforeAll`; no task, lease, cleanup or global
timeout changes. Independent QA approved that separation, not a claim of the
original CI's unique cause.

The first native host rerun then exposed **25 PASS / 1 FAIL** in an obsolete
admission-specific lock method. It had no production callers or formal export;
all real writes already use RunStore. That duplicate method is removed. The
existing regression now replaces the real transaction lock in both no-op
retirement and actual-patch fencing paths; it requires a stable indeterminate
error, unchanged original directory/bytes, no added intent/transcript/temp,
retained replacement lock and unavailable observation. Independent storage
review approves; Linux and native `host-r36-r2.json` each record **26 PASS**. Earlier failures
remain in their original logs. The source change requires fresh emission and a
new full-run/hosted candidate, not a relabeled 4bf result.

The 4bf Linux build/smoke, native Windows boundary job, notification service,
macOS read paths, base/canary/TUI checks passed. Windows downstream artifact
build/smoke was not reached after its failed subset; tag-only publication was
SKIPPED. These are not an overall CI PASS.

The configured bot App/installation works for publication and evidence reads.
Production PRMS fetch remains unavailable: bounded public-port diagnostics found
reviews/PR/checks readable, but `listPRFiles` reached its own 8-second evidence
budget with `AbortError`. That earlier probe exists in the tool transcript, not
an archived full PRMS receipt. Do not fabricate a PRMS `BLOCKED_DRAFT`
report from Draft metadata or weaken evidence collection. Maintainer owns this
out-of-scope evidence-query condition; preserve the read-only diagnostics and
stop only the dependent final PRMS verdict. No authentication fallback or new PR.

Author: finish targeted negative coverage, necessary fixes and independent-review
responses, then full build/typecheck/lint/workspace/docs/count/source-lock gates on
the candidate. Re-run count/status generation until a second pass adds no diff.
Do not run local docs generation that rewrites four unapproved governance projections.
Reviewers: final independent code and QA review of exact final inputs, not old
subset verdicts. Bot delivery: update-only #426, exact head/ref/pull/check identity,
then hosted Linux and native Windows receipts and truthful PRMS Draft result.
Maintainer: provision/approve the separate live subject and deployment parameters,
then real-model Windows/WSL fixture loop and human acceptance. U01, prior 51-item
P2 and true qualification remain separate. No overall completion claim yet.

### Authorized test follow-up after 25db

The retained checkpoint is `25db505a483e871477a7c14e8812da36ba8610e3`, tree
`3908a5f4387163f62187be88f9f340103ce64b31`. The maintainer authorized the exact
Operator test path and existing observation-test repair, without changing global
timeouts, runtime deadlines, Harness or authority. Additive two-file commit:
`33a9f9362edb28bf0c997cc2d91600b9fd425448`, tree
`0cb27a9ba4e4192f9847497578f6d40a32813f6b`. Before bytes, authority, raw receipts
and static-review inputs append in local `followup-tests-r1/`, not a new run.

- **Distinct retained REDs:** local complete R5 at 25db has **8,611 PASS / 1 FAIL
  / 25 SKIP**, Operator expected eight shadow events but saw seven within the old
  polling bound. Hosted Self Validate `40681378907`, attempt 1, job
  `122793139905`, has the same totals but a different failure: the cumulative
  observation test exceeded 60,000 ms (reported 71,389 ms). Later count/security/
  budget-history steps were SKIPPED. Its 275,523-byte raw log SHA-256 is
  `08c6ecb293238c8185dfff281a1b55b4963cdfb3ad7cb288f0783330da271bac`.
  At `12:15:58.373Z`, Release Artifacts `40681378916` separately succeeded,
  including Windows downstream build/smoke; applicable boundary and notification
  jobs succeeded. Tag-only publication was SKIPPED. This is not overall CI PASS.
- **Minimal repairs:** Operator awaits the existing public `observer.flush()`
  before unchanged exact count/order/kind/journal/token assertions. Hung/throwing
  publisher negatives remain. Observation splits the cumulative probe into three
  independent fully hashed fixtures: execute cutoffs, unbalanced-to-balanced
  acceptance, and its own verified/matched control followed by rehashed unbalanced
  inspection. The first required-lease case and original assertions remain.
  Per-case 60,000 ms, task 240,000 ms and cleanup 30,000 ms are unchanged.
- **Measured diagnosis:** an instrumented original cumulative case took 52,820 ms
  locally, including fixture/prepare and repeated fresh execute/accept/inspection
  reads. This neither proves the hosted job's unique cause nor production deadline
  headroom. No pre-run whole-file hash was captured for that diagnostic variant;
  it is not relabeled as candidate validation. Raw console observations remain in
  the tool transcript; before bytes and result JSON are retained separately.
- **Focused GREEN:** actual Linux nobody uid 65534, Node 24.18.1, original Harness
  and isolated qualified tools/caches: `followup-focused-r1` records **9 PASS /
  0 FAIL / 0 SKIP**, exit 0, `12:26:29.117Z`–`12:28:32.493Z`. The unchanged
  first case took 24.678 s; new probes took 24.238 / 30.248 / 34.719 s. Test hashes
  match before/after. JSON SHA-256:
  `9f967241ed6c8afdee7f6b262d13928ae8d8051323c866e94e392d5ad331f6f4`.
  Native Windows `followup-operator-r1.json` separately records **5 PASS**, no
  skip, exit 0. This is not a native run of the time-heavy observation file.
- **Independent static review:** code and QA reviewers approve exact observation
  SHA-256 `ef9416aea1227874d436c5fddc684678675e63fc98cb0a8bc27268aa6c9353f7`
  and Operator `dd2d12f1038670de24aea9d303df512c5498cc7cc5377962f99a37562f32bf6a`.
  All checks, fresh reads, independent mutable state and same-fixture controls
  remain. This is not execution or GitHub APPROVE.

Complete nonprivileged collection now has **8,639 declared cases in 585 files**,
verified by a second no-update collection. The official status generator ran twice
there. Main-checkout duplicate collection was interrupted after about six minutes
of I/O-bound work; its shutdown EPIPE is retained and is not a test or collection
PASS. Only the two numeric registry edits produced by the successful collector
are transferred, with exact content comparison; root status generation and the
final candidate get separate receipts. Root status generation subsequently
completed; a serial repeat from `12:45:37.250Z` to `12:46:15.466Z` exited 0 with
identical before/after hashes. Registry SHA-256 is
`b57ed118a8b646aabc6a5691509544804644da5c5f16633462b9bfa5b4014ac3`; status is
`e05665a01ca023b0fc1383bfb136839a69ad44b65eada9f389ca942565e65bcf`.
Both match the qualified copy; root and copy status verify pass.
This is two added declarations, not repeated-run accounting. Full typecheck and
existing exact-byte contract-family checks passed; lint, workspace, docs verify/
migration, notification docs, Genesis 5/5, golden 7/7 and budget-history checks
passed. Two read-only renders match all four governance projections with zero
projection writes. No source-lock binding or protected source changed.

At this ledger checkpoint final full-candidate execution, hosted Linux/Windows CI
and a new real PRMS attempt remain pending; later bot receipts/comments report
their outcomes without repeatedly changing the candidate just to backfill status.
The last 25db PRMS attempt was unavailable at `prms-fetch` with `AbortError`, not
a fabricated `BLOCKED_DRAFT`. Maintainer-owned subject/provision, real-model
Windows/WSL loop, U01 and human acceptance remain independently open.

## Approved remaining-task batch: N0–N8

This append-only checkpoint is not final acceptance. Starting head is
`5e2ba8ae2039b74b0f6d25feec42dfbc61227b3f`, tree
`fa781383073e9300ab745f6512cc9bdd5aab1f35`. The branch and original Draft PR
#426 are unchanged; no Harness patch, new PR, approval, merge or release.

### Repair and focused evidence

- **N1:** `c469e7f85c517a2062f12e61bfb13918eb1eb569` gives file evidence one
  absolute monotonic 30-second window after client acquisition. Pages, retries,
  backoff and fallback share it; other requests retain eight seconds and parent
  cancellation. Strict fallback rejects omitted original paths and unknown
  change types. Initial PR inputs are copied; final head/base, repository/ref,
  lifecycle, body and classification drift rejects the report. This binds a
  collection window, not an atomic API snapshot or authentication latency.
- Initial N1 RED retains 27 FAIL/18 PASS and three assertion-setup rejections,
  not all valid product counterexamples. Independent late-boundary RED has
  4 FAIL/31 PASS with zero-next-request assertions. Final targeted GREEN has
  **62 PASS/two files**; actual nonprivileged Linux package regression at c469
  has **2,096 PASS/118 files**, exit 0. Build/scoped lint and exact-input
  independent static code, architecture and QA reviews pass. Reviewers did not
  execute tests or give GitHub APPROVE.
- Production configured-bot PRMS at `2026-10-28T15:13:12.503Z` used native c469
  against remote 5e2: 171 changed paths and genuine **BLOCKED_DRAFT** in
  44,712.542 ms end-to-end, including metadata/CODEOWNERS. This is not file-only
  latency or final same-head evidence. Earlier cross-OS module-layout failure
  remains distinct from the subsequent clean native locked install/build.
- **N7/P2:** `d640e00eb8ca090d94ecd5fe1ce501835e46c9dc` and additive type fix
  `56b0783c9f8e0726f49b35e1a07850fdfce20d6c` ensure test subscriptions detach
  even when close throws/times out. Seventeen real-child cases and production
  budgets remain; three expressly inert no-PID branch cases are added. Valid
  RED: 2 FAIL/1 PASS/17 deselections. Earlier spy recursion is a setup failure;
  intermediate TS2540 is retained separately from runtime PASS. Final revision
  passes build, **20 tests**, lint and independent static code/QA review. File
  SHA-256: `cb04ee94bc3f605cc4881f3696d4c875d2056a28146084e0c91f1adb45f0f1c4`.

### Generated inputs and preservation

Official complete collection reports **8,685 declarations/585 files**, not
executed-test PASS. Two root collection/status-generation passes returned 0;
the second made no new changes. Independent nonprivileged collection agrees.
Only four registry counts and corresponding generated numbers change. Registry
SHA-256: `f949f2f6a0b5bd35b23207d2464692ad3417bb104aef08902c8a60572179de3d`;
status: `b10f7cf2f81776ef8d78eac5a1f56754c1fc4fdd5980df495a5e1e5f9d8896d0`.
No signal was sent to the slow collector: the safety check found it already
exited; the full two-pass command later returned 0. Independent static review
confirms the generated output does not claim runtime PASS.

All **229** source-lock bindings were independently rehashed at
`2026-10-28T15:54:54.686Z`: zero mismatches and zero manifest writes. Manifest
SHA-256: `d86ae40f85f5d1dd341807ffee005ecde665ed8397a6f6e982d275578aa6f6c4`.

D: ran out of space during this batch's test edit. New commit/evidence were
preserved on Linux and the test restored from Git: 20,401 B, SHA-256
`e6ba67093b402e680205346afe6d054edc8d74b79d54d8c7fd65f700948548d9`, zero
diff before reapplying. No user change was lost. The user authorized removal
only of the new D-side `starting-5e2ba8ae.bundle` duplicate. Its 13,648,594 bytes
remain at `/tmp/openslack426-remaining-knMLF1/evidence-before-space-repair/starting-5e2ba8ae.bundle`,
SHA-256 `386a62720b20a62af0f207a0f627e3db6fc188be5298c686a29a32f9bf6b7644`;
bytes and complete history were checked before that sole unlink. No old
worktree, original archive/log, identity or credential was deleted. Later
free-space increases and missing old Windows tool/delivery prefixes are
external observations with unknown cause, not this agent's cleanup. The new
native clone and original U01 archive remain. Node recovery uses the official
archive/checksum and a task-only prefix, not global configuration. Failed
safe-directory, NTFS chmod and intermediate type-check preparations keep their
own receipts; no guard was weakened.

### Independent exits and nonblocking work

- **N2:** user separately authorizes single-identity issuance for the fixed
  integration agent/provider cli, only after full validation and if absent,
  in Windows `D:/Users/WSMAN/Desktop/Coding Task/.openslack426-remaining-Yi8EWh`
  and WSL `/tmp/openslack426-remaining-knMLF1/openslack`. Production resolution
  and exact permission negatives are required. No identity has been issued at
  this checkpoint. This is not bootstrap, copied identity, registry change,
  model dispatch, governance qualification or business acceptance.
- **N3/N4:** approved deployment/task references, Windows/WSL real-model loops
  and human acceptance remain separate. Keyless tests cannot replace them.
- **N5/U01:** one C-drive keyless fixture used the original unchanged TGZ
  (SHA-256 `f0cbe8b84929b270a3f9c62536c1a71bc2226f857d12265b3be76c1e3efc8441`)
  and matching retained helper: actual peer exit 0/null, three scripted model
  requests, complete data and native Job empty/drained/graceful were observed.
  Different root, added containment and omission of original type-consumer
  preparation are explicit differences. Original Harness remains fixed/clean.
  This does **not** locate historical exit 1; missing original causal stderr
  and SDK shutdown receipt keep U01 **Unknown**. Original bytes are additionally
  preserved on Linux, not patched or rerun as business work.
- **N6/P2:** clean actual Aby `bd6679f0054960aad27f5d70819d3e5b5c63b779`, tree
  `e77bceeae2d7dca796db8522fc2bf47fd0208584`, passes public availability only.
  Actual peer/model smoke is **NotRun**, not a Harness mainline prerequisite.
  Strict Bridge regressions remain required; no Aby source was changed.
- **N8/P2:** the historical instrumented sample alone does not justify another
  production performance patch. Previous Finding 29 remains Partial; no
  cross-await authorization cache or mandatory profiling platform is added.

Receipts append in local `remaining-20261028-r1/` and
`/tmp/openslack426-remaining-knMLF1/`; old PASS/FAIL stay unchanged. This
checkpoint precedes final-candidate full tests, hosted checks, same-head PRMS
and update-only delivery. Later actual results belong in bot receipts/comments,
not retroactive claims here. Subject qualification, U01, real-model acceptance
and human sign-off cannot be closed by CI PASS.

### Precisely authorized exclusive-issuance follow-up

After the 716 checkpoint, independent QA found the proposed local helper's
absence check could race the existing issuer, which intentionally merges and
overwrites existing identity files. That helper was never invoked. Original
SHA-256 `349fd27524217ee3c00f7a7c371ee6368d94269d98e4d10c9285eb1349e64db2`
is retained as `provision-rejected-absent-r1.mjs`; active copies were disabled.
The user separately authorized exactly `packages/runtime/src/identity.ts` and
its existing identity test, with count/status authority continuing, not a wider
registry, permission, policy, credential-backend or bootstrap change.

Additive `8293c300a65f03515fde1aa56eec6e8cc3c968a4`, tree
`d6f6e0369615a786859ffb38a7876133612e1eea`, adds optional `createOnly: true`:
one `wx` write returns a new identity only after success; occupied targets are
not read, merged or overwritten. The default legacy merge and YAML format stay
unchanged. This is exclusive namespace creation, not a claim of power-loss
atomicity or an authorization source. Independent technical and QA reviews
approve exact producer SHA-256
`359948bf1103c07b7e86753fd44a4782d50837ea2c549f43da5954614b263daa` and test
`cb96d934821733976e0882c6fc65faa2ba668cb88c9e497f376dd5f4770d4172`.
Technical disposition is no-adr: a narrower optional I/O mode, no new execution
capability, permission or durable format; accepted ADR-0003/0004 are unchanged.

The actual RED retains **4 FAIL/11 PASS**, including two successful competing
issuers. Original RED test SHA is
`3034a03ba55500093d7bf6e213611a1cc861fe0f4d5e13e093f4fdecca23b8af`.
Final tests add existing valid/invalid byte preservation and zero-read checks,
occupied namespace, default compatibility, production resolver readback, and
two real independent Node children released from a readiness barrier. Exactly
one winner, one EEXIST and matching on-disk run ID are required; unknown child
exit preserves the fixture. Intermediate TS18047 and a corrected test-only
type-import warning remain recorded, not erased by runtime PASS. Final root
build/scoped lint and **19 tests** (identity 15 plus bootstrap 4) pass. Native
Windows actual formal emission and the same **19 tests** separately pass at
8293. No synthetic test identity is formal integration provisioning.

At this checkpoint the two real identity targets remain unissued; actual use
must pass `createOnly: true`, verify the fixed registry/principal and permissions,
and still wait for complete validation. New code requires fresh candidate-bound
checks; 716's full-suite, hosted and PRMS results remain historical rather than
being relabeled. Existing formal task/deployment, real-model and human-acceptance
conditions remain independent. No model task, approval, merge or release follows
from this exact provision authority.

The complete 8293 inventory collects **8,691 declarations/585 files**. Two
official nonprivileged collector/status passes return 0 with identical hashes;
the only registry edits are total +6 and two overlapping module counts +6.
Source-root status generation also runs twice and both outputs byte-match the
qualified copy. Registry SHA-256 is
`6a6f599f5db795034638623f2f14cfd53f3a139165ceeb76654ce0e66bf283dc`; status is
`58163d9480d85b7359a96651fb8ce0792a36ac3ccb0c5960aa4b4bbbee18709f`.
The module-attributed sum is 11,757/817, not a distinct executed-test count.
No permissions, file counts, maturity or unrelated governance projection change.

### Authorized CI fixture follow-up — 2026-10-29 checkpoint

The user explicitly authorized only these three additional test paths, plus the
already authorized collected counts/status and this existing evidence ledger:

- `packages/agent-runtime/src/__tests__/harness-bridge.test.ts`
- `packages/agent-runtime/src/__tests__/harness-task-host.test.ts`
- `apps/mcp/src/__tests__/governed-composition.test.ts`

Starting candidate is `0368f72ef3c3136685cf0a9af4ef64bbb7703964`, tree
`883e5093c2b50ce49c4b9639df10c3eab1c82746`. Its original hosted Linux forced
shutdown failure and Windows three fixture failures remain FAIL, not retries
relabeled as success. Notification service and Windows boundary jobs on that
head subsequently completed successfully; the artifact and self-validation
workflows still failed. No Harness or production source is modified here.

Necessity and disposition (no-adr, local test lifecycle correction):

- Forced shutdown accepts only the two exact `process_crash` diagnostics that
  production can lawfully return within the unchanged 100 ms fixture cleanup.
  No result, recorder completion or completed-session event may appear. A
  uniquely matched real child must independently close with SIGKILL; a late
  close is not timely/clean business success.
- Each independent host prepares its own real bounded OS witness before ready
  and before the unchanged five-second task admission. Each calls dispatch
  exactly once. Only a typed, bound IN_PROGRESS admission is observed through
  the same canonical route/hash. A held-publication case deterministically
  exercises this path; the actual executor effect must still occur once.
- The lease writer announces ready only after its own OS preparation. Actual
  lock acquisition and lease-expiry/zero-write/evidence assertions remain.
  Parent preparation and bounded per-case test lifetimes are separate from
  the unchanged 10/60-second tasks, synthetic UTC lease and production cleanup.
- Spawned fixtures are immediately excluded from automatic deletion. Only
  actual close and confirmed owned-host stop restore deletion eligibility.
  Cleanup errors augment, rather than replace, the original assertion error.

Independent TypeScript/lifecycle review approves, and independent QA finds the
revised scope statically adequate. Both bind these exact bytes, not a runtime
PASS or GitHub APPROVE:

| Test file | Bytes | SHA-256 |
| --- | ---: | --- |
| harness-bridge.test.ts | 25126 | `22f06123ed153c3836cd17f7dbcfae1b96cb34b33d6ce009a47e0c03248dd981` |
| harness-task-host.test.ts | 30421 | `0d638fc4fe9ef9e2501000946b75d30bf4db0ba475edf00dfe7717bd272ce08c` |
| governed-composition.test.ts | 91452 | `38e224c158e29ad6d7e2b48b743baada91d8b0a8d56ffe6a43690e6c9419a9f3` |

This table preserves the first reviewed cleanup revision, not the final Bridge
bytes. Subsequent counterexamples below required additional same-file changes.

The first local Linux revision has 96 PASS. QA then required the earlier root
protection and primary-error preservation described above. That earlier run
does not cover the revision. The new three-file Linux run has **96 PASS**, exit
0, 62,320.321458 ms; log SHA-256
`0d2eb55f0a1eaa03220e30cd67b49216794ab5679dc7b2544922675cd30dd8fc`.
Both platforms' explicit force-emission preparation returned 0 before testing.
The first native Windows collector ended at its own 300-second outer bound,
before the whole suite reported, and remains **Incomplete/ETIMEDOUT**, log
`7b18f5a88504a74152c781fa4dbb6e3b9ce1da1aa27eee4d26007d8c9f232e08`.
This bound also contained the existing 300-second keyless end-to-end case and
the preceding cases. A separately recorded revised collector allows their
combined duration without changing any test's or production task's budget;
its R2 result is **95 PASS/1 FAIL**, exit 1, log SHA-256
`f49d8eca27ae710cd889983e8dadfa8dba96cb6eb77f72e1806617cd793a37ac`.
The original four CI cases passed, as did the actual keyless SDK/native-MCP
loop (258,148 ms). The remaining failure was the old stdin-pipe fixture:
closing stream/descriptor 0 did not portably yield a write EPIPE. R3/R4
experiments and their failures remain in raw receipts; no production fix or
OS-generated EPIPE qualification is inferred from a later mock.

The final fixture injects two deterministic failures at the public Writable
callback/asynchronous-error boundaries while independently observing the real
child close. The error event is outside the write caller's synchronous catch.
It still requires typed process_crash for send and execution and zero success.
A shared private observer protects roots before spawn and bounds the check,
task settlement and real close separately; all failures retain the primary
error and finally detach. The explicit 20-second per-case lifetimes are not a
change to any production deadline or 100 ms fixture cleanup.

R6/R7 also reproduced over-narrow heartbeat error text and immediate clean-exit
assumptions in three other negative cases. The heartbeat requires typed timeout,
not one wording. Authority still accepts only permission_denied/timeout without
private cause leakage; externally closed waiters require session_unavailable;
failed abort diagnostics must retain diagnosticPersistenceFailed and no value.
Late actual close is separate evidence, never timely clean business success.
Every intermediate FAIL and review-required revision remains preserved.

Final Bridge bytes are **29,104**, SHA-256
`d7ee12f7de0ced93d223cb22aafc7e9e5d6adc3ae9d7ca109870078d371405bb`.
Fresh independent TypeScript and QA static reviews approve this exact revision;
the other two test files retain the table's hashes. R9 executes **40 PASS** on
Linux (8,159.920066 ms, exit 0, log
`d00e3048b062263609d09731419a439a22da59e47a9697982d239143bb373486`) and
**40 PASS** on native Windows (16,080.4301 ms, exit 0, log
`335ef6dde28b9a48e0758c04fbbcacd7ac4a3108ce9cfd4ed68204452521f06f`).
These scoped runs do not replace final-candidate full/hosted gates.

Initial inventory was **8,692 declarations/585 files**, not an executed-pass count. Two
official nonprivileged collection/status passes return 0 with identical
registry `2f47ca656fd0c3beb24de113d4a2c17e82d083ac7a15ed49a69572fd22639615`
and status `5aa8db3e74172c0532c38ad073f44313075d70eeab9d1d08ce803d934c2e4e6d`.
The second public-I/O fault case adds one more declaration. R5's two official
collector/status passes return **8,693/585**, both with identical registry
`a98ffbd3bd1535e15e5a480339c08d67b76b61857f7e0be48211e9b3115c964b`
and status `6ea6bbce9aba2dacc1689a9b305ce24c02ee639d443d8cc72096f3e57d69bc85`.
Later refinements change no declarations. Final-candidate count verification
must still run; this does not transpose R5's runtime results onto R9.

The two precisely authorized production create-only issuance operations did
subsequently succeed on the prior fully locally validated head. Windows uses
`RUN-20261028171531-enafyr`; WSL uses `RUN-20261028171537-ecm2vp`, both provider
`cli`, fixed `custom_developer_harness-integration`, with unchanged registry
and negative permission checks. Issued locally is not qualified execution.
Following the user's establishment instruction, each platform now owns a
separate `.openslack.local/harness/home` initialized using the original public
plugin manager, with the external plugin linked offline/ignore-scripts. No SDK,
model, credential service or task execution was initialized. Noncanonical
`preparation-20261029-r1/deployment.draft.json` records the independent task
intent, exact fixture, 240-second task, report and fixed text verifier. Windows
draft SHA-256 is
`32e4f5882bc0bcb93ca405c8c2ee570435acab52211d14502ebe061839ddf69f`;
WSL draft is `8f9060a123271e2b082f49d7a328712fd77d57331c361b1baa8bafe99b14b97c`.
They are inactive and require final-candidate rebinding and formal task/deployment
qualification; canonical `deployment.json` and task registration are not written.

The public route `deepseek-official`, explicit model candidate `deepseek-flash`
and credential-service reference `DEEPSEEK_API_KEY` are nonsecret proposals,
not account availability evidence. The fixed SDK's implicit model default
differs from the static provider catalog, so implicit selection is not used.
No pure independent metadata factory was found: service initialization can
read/migrate the credential store. No such initialization, secret generation,
credential borrowing or secret-value inspection was performed. Credential
configured/source remain Unknown until supplied through the proper owner's
existing service. Real Windows/WSL model acceptance and human sign-off remain
separate, as do U01 Unknown and optional Aby/performance follow-ups.

Append-only raw evidence is under `remaining-20261028-r1/ci-followup-20261029-r1`
and `/tmp/openslack426-ci-followup-Kl0SqX`. This checkpoint precedes the final
candidate's complete gates, hosted CI, update-only #426 synchronization and PRMS;
their later actual results belong to bot receipts/comments without rewriting
these historical outcomes. Draft, no approval/merge/release and zero Harness
patch boundaries remain unchanged.
