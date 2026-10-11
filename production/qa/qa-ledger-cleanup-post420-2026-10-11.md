---
schema: openslack.document.v1
id: qa-ledger-cleanup-post420-2026-10-11
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: qa
updated: 2026-10-12
sources:
  - production/qa/qa-plan-cleanup-permit-2026-09-21.md
  - services/cleanup-broker/handoff.md
  - docs/security/human-approval.md
---

# QA Ledger: cleanup handoff after PR #420

This is a QA ledger and evidence index. It is not a PASS record, not an approval, and
not deployment evidence. It records what was measured, what failed, and what remains
unproven for the deployment candidate frozen after PR #420.

## Batch identity

| Fact                              | Value                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| Deployment candidate              | `6c8a2bcc2d6a8912c53a53ab7f3377af0ed8705b`                                            |
| Governance `main` at verification | `0f7a698b288a4f4353e1faf11c9f9304ccbd3d84`                                            |
| Candidate versus `main`           | ancestor, and byte-identical source tree (`7e6282e894aac11e54db088d9eef0ca2fb385ab5`) |
| Governance repository             | `Negentropy-Laby/OpenSlack`, id `1239520892`                                          |
| Qualification repository          | `Negentropy-Laby/openslack-cleanup-qualification`, id `1380965476`                    |
| Target host                       | `OpenSlack-Cleanup-Qual`, Ubuntu 24.04.5, ext4 persistent state                       |
| Fixed identities                  | Broker 44180:44180, Agent 44181:44181                                                 |

## Ledger

| Stage                                | Result                        | Evidence                                                                                                                                                                                                  |
| ------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate and artifact verification  | PASS                          | Five artifact digests recomputed from bytes; build A byte-identical to build B; both retained checkouts clean at the candidate; candidate is an ancestor of `main` with an identical tree                 |
| Retained-runtime cross-check         | PASS                          | A third clean checkout reproduces both build reports' `lockfileSHA256` and `goModuleSHA256`                                                                                                               |
| Target observation                   | PASS, with a material finding | Target carries a complete six-destination layout built from the earlier candidate `a5b16b915fba3a5a6915a41dda37cb09efc4504c`, never started, with no ledger, no journal, no lock and no process           |
| Upgrade-evidence validator rehearsal | PASS, 9/9 controls            | Baseline accepted; a group-writable evidence input, an impossible process state, an expired window, a proxy disagreement, a wrong repository binding and an unattested task-view digest were each refused |
| Packaging-path rehearsal             | PASS                          | A complete v2 package (33 files) was produced from the reused builds; the independent verifier returned `valid=true` with no errors                                                                       |
| Upgrade-plan rehearsal               | PASS                          | `evaluateCleanupTargetUpgradePlan` returned `0`; the only outstanding gates were the four administrator gates                                                                                             |
| Real qualification matrix            | **NOT RUN**                   | Blocked on the administrator gates below                                                                                                                                                                  |

Claim status for every qualification case remains `not_required` / `not_evaluated`. No
case has been executed and no Permit has been issued.

## Deployment status

| Gate                            | State                                                         |
| ------------------------------- | ------------------------------------------------------------- |
| Repository repair after PR #420 | merged                                                        |
| Handoff-package acceptance      | not started — no package for this batch has been produced yet |
| Installation                    | not performed                                                 |
| Activation and Permit           | not issued                                                    |
| Real qualification              | not run                                                       |

The Broker was not started at any point in this work. Nothing was installed, and no
state was created, cleared or migrated on the target.

## Findings recorded for this batch

**The target is a partial installation, not a fresh host.** Its six artifact
destinations match the earlier PR #418 handoff package's published digests, so the
fresh-install branch of `handoff.md` — which requires every fixed target to be absent —
cannot apply without deleting state. The reviewed controlled-upgrade path is used
instead, and deletion is not performed to satisfy a precondition.

**The approved egress proxy is owned by an ungoverned desktop process.** The recorded
proxy address still answers, but it is served by a user-installed desktop proxy client,
and direct requests resolve into the fake-IP range that the same client's transparent
mode uses. Egress is therefore intercepted whether or not the proxy variable is set,
and the address is a per-boot WSL2 NAT gateway rather than a stable service address.
This is escalated, not waived; the network evidence cannot be confirmed until an
administrator records a decision.

**Evidence files must live on a Linux filesystem.** Files reached through a Windows
drive mount under WSL2 report mode `0777`, and the strict evidence boundary correctly
refuses them as `UNSAFE_FILE`. An earlier draft that used such paths could not have
passed.

**Every evidence class is bound to the same batch identity.** An evidence file
generated with a different `workspaceId` is refused as a binding mismatch even when its
contents are accurate, which makes the workspace identifier a required input to
evidence collection rather than a label.

**A manifest-versus-target disagreement is expected for a partial installation.** The
package's draft installation manifest describes the intended post-upgrade state, so the
destinations being replaced are reported as disagreeing with the target. The manifest
is not authoritative and this changes no action.

## Evidence index

| Evidence                                          | Kind                                                          |
| ------------------------------------------------- | ------------------------------------------------------------- |
| Candidate dual-build proof and both build reports | build-host proof, reused unchanged                            |
| Two retained candidate checkouts                  | build-host proof, preserved                                   |
| Third clean candidate checkout                    | packaging `sourceRoot`                                        |
| Administrator-signed input record, 2026-10-08     | historical provenance; hash preserved, approval not inherited |
| Target host facts and dependency inventory        | live target observation                                       |
| Upgrade-evidence validator rehearsal transcript   | agent verification                                            |
| Packaging and upgrade-plan rehearsal transcripts  | agent verification                                            |
| PR #418 handoff package                           | historical package, retained and readable as-is               |

Rehearsal packages and rehearsal manifests are explicitly excluded from this index.
Their digests must never be recorded as deployment bindings.

## Outstanding before this batch can proceed

1. An administrator decision on the egress proxy trust finding.
2. A refreshed least-privilege deletion App scope observation.
3. An administrator-attested complete task scope for the qualification repository,
   taken fresh rather than inherited.
4. Fresh target evidence collected inside the approval window, then the package, then
   the package verification and the upgrade plan.

Old records are retained as sources only. They do not carry their validity window or
their approval into this batch.

## PR #421 administrator-toolkit development batch

This batch starts from `438e9148fcf744b8e2f540f5344b12bbfe7b829b` on
`docs/qa-ledger-cleanup-post420`, targeting the live canonical `main`. All repairs
continue in PR #421. The preceding observations, rehearsals, approvals and build
reports remain historical evidence; they do not establish this batch's source,
target state, validity window or approval. The final candidate and independent
build digests are published with the PR evidence after the source is frozen.

The separately versioned `openslack.cleanup_admin_toolkit.v1` package contains
eleven tool/document/shared-code files, two independent build reports, its
manifest and `SHA256SUMS`. The existing v1/v2 handoff profiles, five core artifacts,
Broker protocol, selected registry bytes, identity bindings and Permit consumption
rules are unchanged. An administrator toolkit is not an installable handoff package
or an execution authorization.

### D01 source dispositions

| Source                                                                               | Recorded SHA-256                                                   | Disposition                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen safe target collector `collect-target-facts-safe.6107c2d9d14d.py`             | `6107c2d9d14d720bb3e60714a7e3e1d40446bafff1b074d0270e747de548596d` | Reviewed source lineage for the imported observer; platform-before-import checks and no-bytecode behaviour are separately reviewed changes, not a claim of unchanged bytes |
| Frozen dependency collector `collect-installed-dependencies.ee4f0770336e.py`         | `ee4f0770336e1a51733d351954e3d6621ca19b49b8a532e2cdacf524401f6827` | Reviewed ELF load-time closure implementation; the actual adjacent observer digest is refreshed from its bytes                                                             |
| Administrator fixture source `T04-fixtures.mjs`                                      | `b32292eae27958064ce5078af4298a32d68df36758d57fbeb794a30b6c6b3d86` | Fixed human/repository checks retained; strict local decoding, directory binding and uncertain-result persistence repaired with regressions                                |
| Old path-based collector and `build-t05-evidence.ts`                                 | Not adopted                                                        | Not formal collection or conversion sources; inferred installation claims cannot substitute for observations                                                               |
| Recursive backup, historical vacuous isolation reports, rehearsals and old approvals | Not adopted                                                        | Preserved as historical material; never promoted to current installation, isolation or approval evidence                                                                   |

### Delivery tasks and acceptance scope

| ID  | Priority | Implementation and evidence scope                                                                                                                                                                                      |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01 | P0       | Reviewed source provenance and excluded inferred facts, rehearsals and inherited approvals                                                                                                                             |
| D02 | P1       | Fixed-path target and dependency observers use actual metadata/bytes, Linux descriptor anchors, bounded reads and exclusive outputs; dependency evidence is only the ELF load-time closure                             |
| D03 | P1       | `prepareCleanupEvidenceDraft` validates selected inputs and seven source classes, preserves current versus planned installation facts, bounds the output window and publishes DRAFT records only                       |
| D04 | P1       | Fixture plan/create/inspect/close/merge phases verify the independent human and fixed qualification repository; exact interactive confirmation precedes each mutation; no approval or branch-deletion path exists      |
| D05 | P1       | Offline backup is restricted to installed but never-started, empty-history targets; fixed non-secret files, original metadata, explicit absences, dual synchronization and in-backup restore verification are retained |
| D06 | P1       | OS/installation isolation, separately parsed fixed identity/private workspace and actual PID/nonce inspection have distinct results; absent post-start objects cannot PASS                                             |
| D07 | P1       | Separate toolkit preparation binds two actual tool collections and reports from independent clean clones; the offline verifier requires an externally supplied candidate and checksum digest                           |
| D08 | P0       | Behaviour regressions, final source checks, independent read-only review and current-head hosted checks remain required; component green results are not target qualification                                          |
| D09 | P2       | The administrator README and handoff navigation document exact commands, required inputs, expected outputs, authorization boundaries and stop conditions; pure formatting is not a deployment dependency               |
| D10 | P3       | No unrelated cleanup performed; old packages, approvals, build sources, failure logs and recovery evidence remain preserved                                                                                            |

The toolkit does not collect credentials, create actual fixtures, install artifacts,
start a Broker, issue activation or a Permit, or delete a branch during this
development batch. Pure parsing and explicit platform refusals run on all test
platforms. Linux-only target operations do not silently fall back to path checks.
Local Windows fixture persistence is explicitly file-fsync-only, not directory
durability or Broker execution qualification.

### Independent-review regressions

| Finding                                         | Reproduced failure                                                                                                                     | Repair and acceptance assertion                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup child-directory replacement              | Renaming `files` or `restore-verification` after copies still yielded PASS while manifest paths no longer located those bytes          | Hold created child descriptors and verify their parent entries before copying, syncing, publishing and returning; replacement is BLOCKED and partial output is preserved                    |
| Optional-file absence drift                     | A previously absent configuration/manifest could appear before completion without being backed up or invalidating the recorded absence | Retain anchored absence evidence and revalidate before publication; appearance, links, unreadability or an unverified parent block the route                                                |
| Fixture parent-directory link                   | Planning through a linked scratch parent wrote outside the selected directory                                                          | Reject linked parents before creation; Linux writes use internally held directory descriptors across confirmation and asynchronous requests                                                 |
| Uncertain mutation and failed state publication | A lost response plus failure-state rename error left a planned manifest and allowed another send                                       | Fsync and preserve the exclusive phase lock if failure-state publication cannot complete; the original error and persistence failure are retained; a later mutation cannot acquire the lock |
| Unbound fixture manifest fields                 | Changed static disposition/parent and unknown fields reached confirmation despite unchanged plan bytes                                 | Strict manifest keys and the full static plan projection are checked before GitHub reads or confirmation                                                                                    |
| Lock descriptor failure                         | Failure in lock `fstat` or directory synchronization leaked the opened descriptor                                                      | Register ownership immediately and close on every initialization failure, while retaining the incomplete lock and sending nothing                                                           |
| Fast-restart nonce ambiguity                    | A nonce timestamp 500 ms before the current process was accepted by a one-second tolerance                                             | Use bounded UTC/CLOCK_BOOTTIME sampling and kernel-tick uncertainty; an old or ambiguous instance is BLOCKED, with PID/executable/identity rechecks retained                                |
| Missing fixed-identity/workspace acceptance     | OS/installation isolation was described as proving a runtime identity and private workspace it never read                              | Separate read-only workspace entry safely captures bytes, calls production parsers and permission checks, never bootstraps, and does not produce an executable principal context            |

The reviewer is a separate read-only agent that did not implement these changes.
This is independent automated review, not human approval or an external production
qualification. Original failing regressions and diagnostic logs are retained
outside the checkout. Tests that deliberately disable a repair must fail; they are
not included as failing results in final acceptance.

### Environment and remaining external gates

The initial full typecheck and executor integration attempts exposed an environment
with no real `node` in PATH. Bun's substitute could not load the existing tsx CJS
entry; Go integration reported the actual missing executable. After selecting the
already verified Linux Node 24.18.1, both paths pass without source, assertion or
VCS-stamping changes. This is a corrected validation prerequisite, not a claim that
the deficient environment was qualified.

Formal target collection and conversion still require fresh target facts, App scope,
proxy ownership/trust and an administrator-attested complete task view. Hostname,
UID/GID and selected bindings are expectations to verify, not proof of provisioning.
Source build proofs and the administrator toolkit can be delivered without these
records; a formal installable handoff package cannot. Administrator input approval,
backup/deployment, fixed credentials/identity, startup, governance activation/Permit
and the complete real qualification matrix remain separate NOT_RUN/BLOCKED stages.

### Final source acceptance before freezing

The final Linux full-suite report contains 7,964 tests: 7,958 passed, zero failed
and six pre-existing pending cases. Each of the three consecutive affected-suite
reports contains 1,015 passed cases, zero failed and zero pending. The production
collector records 7,964 declared cases in 546 files, including pending cases; this
inventory is not substituted for an execution result. The 193 new Vitest cases in
five files also drive 82 Linux Python behaviour/dependency regressions; the latter
are nested fixture checks rather than additional Vitest inventory entries.

Typecheck, build, workspace validation, golden evaluation (7/7), genesis (5/5),
document verification/migration/notification checks and status verification pass.
ESLint reports zero errors and zero warnings. Node's pre-existing package-type
notice for `eslint.config.js` is an environment diagnostic, not an ESLint result;
no rules, suppressions or package semantics were changed to hide it. Cleanup
Broker Go race, vet and the actual Linux executor integration pass with Go 1.26.5
and the verified Node 24.18.1 in PATH. Source-manifest intersections are empty:
no bound paths, scopes or digests need updating for this batch. The second status
and documentation generation changes zero files.

Native Windows full-suite execution, source-only dual builds, toolkit verification,
current-head hosted CI and PRMS are recorded against the frozen candidate in the
PR evidence. Earlier-head results do not qualify that candidate. Independent
review covers the implementation rather than deciding human approval. No target
collection, deployment, service startup or real GitHub mutation was executed as
part of these fixture and source checks.

| Local evidence             | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| Full Linux Vitest          | `cca8fec75a371508e699e780dc22fe656348363cea754fa424da15d582b28356` |
| Affected pass 1            | `00469b833323ee40a57a8c16811ddd344c261a22b456cbc9e2e75fb8cbcf868e` |
| Affected pass 2            | `de603fa95a377471a9e256cd2b9c479b0096ff318de461c5ad6ab0a3cd4bb606` |
| Affected pass 3            | `c7e199ccd7ac55acb608ba15e249c2ff3f6e7f6582551409164d38d26a4825f8` |
| Typecheck                  | `5b2f9dd58fae414bc31715e037823f044935b648ad8de7f10909ca19b9e1e8a2` |
| Lint                       | `a3067e5aaa8971a6d0b0b3f627db793a031bbfdc1afe191251966ac8232759c1` |
| Go race                    | `93b828336959a18fc440cab162a188a03d8a30775e279b899e9ea95c686349d8` |
| Go vet                     | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Linux executor integration | `68cb65d6ef9b13baa73c6630def9da1cd89c29ff96c83e039ebd4763205cb9bd` |

### Native Windows follow-up and candidate replacement

The first native Windows attempt on `b144463a` exposed a validation-host PATH
prerequisite: the shell could locate Bun by its absolute application path while
`cmd.exe` could not find `bun`. The repaired driver normalizes only its child
process PATH/PATHEXT and explicitly waits for native exit codes; it changes no
machine or production environment. Typecheck then passes. The original launch
and typecheck logs are retained rather than counted as successful acceptance.

That native targeted run then reports three failures with one actual cause:
`inspect-instance.py` resolved `time.clock_gettime_ns` in a default argument while
importing. Windows has no such API, so it crashed before the deliberate platform
refusal. A strengthened regression removes the API on Linux and first fails;
the fix resolves it only inside the Linux timing helper and checks capability.
No BOOTTIME/UTC interval, kernel-tick, PID/executable/identity binding or clock-drift
assertion is weakened. Independent read-only review separately removes all Linux
clock APIs, observes explicit refusal with `nonce=null`, and verifies the original
Linux timing/instance assertions.

New Linux-only IO tests are explicitly separate from all-platform parsing and
zero-IO refusal tests. Conditional declaration replaces the new `runIf` wrappers;
no skip, swallowed body or synthetic Linux PASS is used on Windows. The reviewer
compared test bodies and assertions before/after and confirmed they are unchanged.
The Linux production inventory remains 7,964 cases in 546 files; actual Windows
collection is reported separately rather than forced to match Linux IO cases.

The `b144463a` source proof and 15-file toolkit are preserved as original-candidate
build evidence, not proof for the repaired source. The new frozen head, fresh dual
builds and complete native Windows result are published with the synchronized PR
evidence. No source proof becomes target installation, administrator approval or
real cleanup qualification.

### Hosted runner fixture corrections

The `6a3bc0a8` hosted Linux validation run `38150650795` and Linux release
qualification run `38150650475` expose 14 failures in two new test files. The
original failed checks are retained as pre-fix evidence, not retried to manufacture
a passing result. One Node-entry test hardcodes the developer's Bun installation;
it now resolves and probes Bun through the existing shared process fixture.

Thirteen workspace tests assume the runner has only its primary group. A shared
hosted runner can have additional privileged groups and the production verifier
correctly rejects that identity before reaching the intended filesystem controls.
Only the test child now models the dedicated Agent's supplementary-group fact.
Real UID/GID, files, descriptor anchoring, production parsing, path authorization
and permission checks remain unchanged. A separate negative regression supplies
an additional group and asserts OS-identity refusal, zero workspace opens, no
identity observation and no outbox creation. No production option supplies this
fixture fact, and deployed tools still reject extra groups.

The two corrected suites pass 79/79 locally; their report SHA-256 is
`3f2d29da1909ffe9da539941bd0d3d4769ee65db32f2f4dc83aa52c70614758d`.
This is fixture portability evidence, not target isolation or administrator
qualification. New candidate, dual-build and current-head CI evidence replaces
acceptance claims for `6a3bc0a8`; its earlier source proofs and toolkits remain
unchanged historical records.

The new Linux IO suites also consume the existing collection-only platform
marker. Windows native execution still declares only its pure/platform-refusal
cases; the production counter collects Linux declarations without executing
them, so Windows status validation does not silently undercount Linux coverage.
No runtime invocation sets the collection marker, and no conditional test body
is replaced by an empty result. Independent review confirms the two portability
fixes retain every prior assertion and add one extra-group refusal regression.

After these fixture corrections, three consecutive combined acceptance runs each
pass 1,016/1,016 with zero failed or pending cases. The production inventory is
7,965 declared cases in 546 files; the single additional Linux case is the
supplementary-privilege refusal. Independent read-only review separately runs
146/146 across the three corrected suites and verifies the unchanged production
controls and collector-only declaration matrix.

| Revised affected evidence | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| Consecutive pass 1        | `6e9b04e8acf29847bab12698886c34b71458404fe5a82ae589bac86e3e1992e5` |
| Consecutive pass 2        | `26f352245c2b0a1c44d7b24199a74ed64fb16aa21bebf6c206075547c2bf9fd5` |
| Consecutive pass 3        | `5d98f96e9507dca69bc2d72c55cec46e47c13954e75017812402246aaef3979c` |

### Full-suite Graph fixture ownership correction

The `41e5e53d` complete local Linux run reports 7,958 passed, one failed and six
pre-existing pending cases. The failure is the Organization Graph generator
integration scenario reaching its existing 120-second limit; an isolated run
also fails at 120,027 ms. The source of the generator and this test is unchanged
from `438e9148`, whose earlier run passed in 99,636 ms. The same-head hosted Linux
job `114508004573` passes the scenario in 76,848 ms and the whole inventory in
7,959 passed/six pending. These differing results establish environment-sensitive
test ownership, not a completed local acceptance or a new generator behavior bug.

The previous single scenario launched ten generator processes and combined
determinism, stale repair, extra-file refusal and two distinct link refusals.
Those are now four real scenarios with private fixtures and the existing
120-second limit per scenario. This restructuring increases the aggregate
worst-case allowance to four times 120 seconds; it does not change any production
deadline or the generator's combined structure/stale diagnostics. Every original
assertion remains, including regenerating stale content and regenerating after
removing a mirror link. Exact stale-repair bytes are additionally checked.

Generator processes run the real Bun script directly through the shared verified
executable resolver. Native Windows failures are no longer retried through WSL.
Vitest cancellation and assertion-failure cleanup stop the owned process, await
its actual `close`, and settle the complete initialization/scenario before
removing private directories. A signal already cancelled cannot launch another
process. There are no automatic test retries, enlarged timeout constants, new
skips or production-generator changes.

Two fail-first regressions prove the ownership defects: the old abort callback
reports no actual termination signal, and child-only settlement returns before
a controlled asynchronous continuation releases its fixture. The independent
review also catches the initially lost stale-repair assertion and the fixture
initialization race; both are repaired before acceptance. A separate read-only
review runs the two lightweight regressions and confirms all prior assertions.
The revised complete Graph file passes 12/12, with the four generator scenarios
at approximately 34, 18, 27 and 24 seconds. The production collector now records
7,970 cases in the same 546 files: three separated scenarios and two ownership
regressions add five declarations. Final full-platform results and replacement
source/toolkit proofs are recorded against the new frozen PR head, not inferred
from these targeted results or the previous candidate's hosted checks.

The original `41e5e53d` native Windows run subsequently completes with 7,586
passed, zero failed and 80 existing platform-pending cases (7,666 actually
declared). Its production inventory verification still covers 7,965 Linux and
all-platform declarations. That native report has SHA-256
`5c27a0df32ae1f446925f7f9fef7172ff48137c37299eeabfacb72bceaeef0c9`.
It remains original-head evidence; the Graph fixture correction must obtain its
own complete native run. Normal native execution never sets the inventory-only
marker or pretends that Linux IO tests ran on Windows.

| Preserved failure evidence         | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `41e5e53d` full Linux run          | `f21527ee5d5e938687214468eab39db09bd7c2f64b43065d4c8c2bf619c2b5e7` |
| Isolated generator timeout         | `f6dde86be86227ce89b14d97b91e5572f7010333ac034bd061e90c46a9f469bb` |
| Abort callback before fix          | `48a8d2733a9deb5f8c1d79f2955eab72245d8d989e869ba89efd95d1a55063c6` |
| Continuation settlement before fix | `c4be79603e21ceb444cc8f2d901903c270d51e3871a3fb8d5e3b87c83b40eec0` |

The final combined source acceptance adds the CLI cleanup command suite and the
revised Graph integration scenarios. Three consecutive runs each pass 1,106/1,106
with zero failed or pending cases. These are source and fixture checks, not target
installation or real cleanup evidence.

| Final affected evidence | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| Consecutive pass 1      | `b911313f6f13db72ee46831e81e02c7b8644dd94cd8a6eec4b9654d2c4f83d49` |
| Consecutive pass 2      | `62731e3cdbaa6cb50f16f2a55a11587f7413565582abaceec0eba10931f4613e` |
| Consecutive pass 3      | `e28f8521777b7ecee06be4b8e431fc6e07b74adb83d1b678ee7a0f306eb1d618` |
