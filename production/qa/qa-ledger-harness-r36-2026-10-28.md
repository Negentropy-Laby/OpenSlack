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
`184adb088c6157ceec148061a6b8cef5f8444377`. Repairs are uncommitted until their
own delivery receipt exists; that starting SHA never identifies dirty inputs.
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
  `failed-six-r4.json` phase has 73 PASS/1 SKIP. A new full compatibility run is
  pending; those focused results do not replace the failed full run.
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
  inspection local. Initial stale-inventory failures remain failures; complete
  collection and idempotent status generation are pending.
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
| R36-01 | P0: orphan locks must not poison all observations. | Shared `run-ownership.ts`; strict reads still refuse unresolved locks. `RunObservation`/per-entry listing isolate unavailable runs. ADR-0004 nominal inspection + explicit fixture-only repair archives and proves owner death before retirement. Storage/recovery phase GREEN; final/platform QA pending. |
| R36-02 | P0: creation cannot mix owners or overwrite partial publication. | Common ownership, v2 creation/metadata/transaction identities, fsynced immutable intents, exclusive metadata then canonical publication. Crash windows classify proven safe failure or unavailable; no automatic rollback/replay. Real two-process ordering and partial-publication tests. |
| R36-03 | P1: reclaim only provably undispatched capacity. | `recorder.ts` opaque process-private receipt; prepared/authorization_attempted/settled/not_dispatched. Original new owner alone may reclaim; attempted/legacy/foreign receipts retain capacity. Lease RED/GREEN, repeated pre-effect checks and independent correction review pass; plugin r3 passes. |
| R36-04 | P0: public append must share create/update ownership. | `transcript.ts` delegates to the common store owner before checking canonical existence; append and watermark publish together. Legacy-only bytes prohibit same-ID create. Baseline RED; deterministic two-process GREEN. |
| R36-05 | P1: persistence faults cannot hide the provider failure. | Launcher preserves primary cause/run ID with bounded nonsecret secondary diagnostics, including initialization, Aby reserve/settlement/usage. Reused-ID and double persistence failure regressions pass. Smoke cannot substitute a historical run for a new failure. |
| R36-06 | P1: local clock jumps must not renew elapsed budgets. | Bridge/startup/owned-host local timers use first `performance.now()` deadlines; explicit UTC lease/task limits remain independent denial bounds. Wall-clock regressions and final platform run pending. |
| R36-07 | P1: close during start needs real facts. | Immediate public non-lazy SDK close, no initialize wait or fictional pid -1 for attempted startup; observer stays until close settlement. Four actual SDK fixture cases phase GREEN. No claim of inevitable leakage from the fixed SDK. |
| R36-08 | P1: finite caller read budget must be honored. | Explicit `{waitMs,signal}`, one monotonic deadline, default 1 s, longer finite waits honored, Infinity rejected. Real 1.25 s writer/2.5 s budget GREEN. |
| R36-09 | P1: corrupt/mismatched records cannot hide healthy records. | Ready/missing/unavailable observations, healthy ordering and unavailable entries survive untrusted filters; CLI/MCP/TUI diagnostics surface availability instead of empty success. Mixed-record and MCP activity tests. |
| R36-10 | P1: observation and authorization have different availability semantics. | Visible-anchor-only activity and reconciliation use explicit availability. Workflow maps only nominal invalid-state/snapshot-conflict errors to local-invalid/reconciliation diagnostics; strict reads still reject, non-strict reads never reuse a locked snapshot. New strict/non-strict byte-preservation regression passes; worker bootstrap stays strict. |
| R36-11 | P1: catalog pages cannot exceed startup budget. | Connect/all tools-list pages/ready share one monotonic deadline, timeout+signal and outer bound; no reconnect. Real delayed/paginated server RED then 6-case phase GREEN. |
| R36-12 | P1: published admission must not lose its owner on unlink failure. | Explicit publication-unconfirmed handoff keeps route owner; host records stop/non-executable failure and reports indeterminate, never normal pending. Exact admission-unlink regression under final rerun. |
| R36-13 | P2: preserve policy is intentional, not unnoticed cleanup permission. | Keep trusted provider policy and safe external default; no restoration of destructive cleanup. Compatibility explanation and regression inventory remain to finalize. |
| R36-14 | P1: durable confirmation plus failed observer is not unexecuted confirm. | Single settlement path; typed immutable durable record and stable settlement-unconfirmed MCP outcome. Nine sync/async/combined-failure tests pass; vault binds only exact durable dispatch query route and rejects changed plan/task/action/state/blocker/settlement. No new execution or replay grant. |
| R36-15 | P1: already-open LLM streams must stop forwarding. | Per-chunk closing/eligibility guard using `for await`, IteratorClose on rejection. Mid-stream close/expiry RED then 21-case phase GREEN. |
| R36-16 | P1: keep link rejection but expose safe actionable diagnosis. | Typed `HARNESS_ROOT_UNSAFE`, safe physical-path guidance through CLI, no raw OS path/cause and no junction allowance. CLI regression phase GREEN. |
| R36-17 | Contract: fixed public dependency layout is deliberate. | `runtime-public.mjs` validates exact approved MCP 2.2.0 root/stdio export layout and gives explicit compatibility-upgrade refusal, not guessed private resolution. Actual public-package build passes; version/string-export/missing-types/default negatives are added for final full execution. |
| R36-18 | P1: startup interruption is not proof of prior service. | Separate everServed/closeRequested; one safe error renderer. SIGINT/SIGTERM-before-start and EOF phase tests GREEN. |
| R36-19 | P2: optimize measured work without delaying confirmed evidence. | No-change patch checks skip checkpoint publication; required ownership, scan and fsync remain. The scoped warm Linux 16-fsync trace above is measured, not inherited 6-transaction/full-loop evidence. No confirmed event is delayed; further necessary optimization remains separate. |
| R36-20 | P2: cache bytes, never authority. | Existing phase-local opaque observations retained. Cross-stage cache may reuse hash calculations only behind fresh FD/directory witnesses; measurement and implementation pending. No permanent cached permission. |
| R36-21 | P2: CI must share preparation without hiding qualification. | Both CI entries now invoke explicit fresh compatibility emission. Existing exact pin/preparation parity still protects duplicated upstream preparation; common minimal dependency prepare and download-only cache pending. |
| R36-22 | P2: absence optimization cannot conceal unsafe/denied reads. | Reject proposed `existsSync` shortcut. Stop checks retain path/link/permission validation; measurement for safe coalescing pending. |
| R36-23 | P1: shared stable bytes with RunStore precision. | `run-files.ts` wraps Core stable descriptor bytes and retains caller directory policy plus bigint/nanosecond FD/entry checks. No portable fixture authorizer is used. Storage/link/CAS phase GREEN. |
| R36-24 | P1: MCP and host storage policy must not diverge. | Export/reuse `assertHarnessRunStorage` through the internal host barrel; MCP private traversal removed. Unsafe paths still fail closed; visible unavailable output separately tested. |
| R36-25 | P1: one cleanup contract, not ineffective knobs. | Pure wire leaf owns 24 s owned /25 s grace /5 s force /30 s total constants; host/plugin/provider reserve it. Legacy Harness exitGraceMs values other than 30000 reject explicitly. Configuration negatives and Linux artifact/Bridge regressions pass; native keyless SDK/process subset passes separately. |
| R36-26 | P1: one resolver classification must govern the whole path. | Resolve the sealed persisted Workflow target, not Scenario executor ID; one family used for both permission and definition path. Unsupported targets do not fall back. Wrong worker/initiator target and Scenario regressions GREEN. |
| R36-27 | P1: roles must come from trusted composition. | Required frozen worker(runId)/initiator discriminator in vault; host derives one validated frozen role and publishes targets from it. Model/observation cannot mint it. Role-confusion negatives and scoped independent consumer review pass. |
| R36-28 | P1: avoid allocating the maximum for every tiny state. | Core byte reader allocates actual descriptor size; bounded guard retained. Shared strict-read regression and final metrics pending. |
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
  zero projection writes. A final complete compatibility run and hosted CI are
  still pending; preserve each phase's original input/timestamp rather than
  re-stamping it as the eventual commit.

The original Windows authentication workspace's package-owned bot entry was
verified against the existing bot-author open Draft #426, matching ref/repository
and base, no auto-merge. The delivery clone was clean at 9f33. This proves the
preflight only, not publication. P2 cross-phase byte-cache work and common CI
download preparation remain pending; U01, live subject/model and human acceptance
remain independently outstanding.

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
