---
schema: openslack.document.v1
id: qa-ledger-cleanup-post420-2026-10-11
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: qa
updated: 2026-10-11
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

| Fact | Value |
| --- | --- |
| Deployment candidate | `6c8a2bcc2d6a8912c53a53ab7f3377af0ed8705b` |
| Governance `main` at verification | `0f7a698b288a4f4353e1faf11c9f9304ccbd3d84` |
| Candidate versus `main` | ancestor, and byte-identical source tree (`7e6282e894aac11e54db088d9eef0ca2fb385ab5`) |
| Governance repository | `Negentropy-Laby/OpenSlack`, id `1239520892` |
| Qualification repository | `Negentropy-Laby/openslack-cleanup-qualification`, id `1380965476` |
| Target host | `OpenSlack-Cleanup-Qual`, Ubuntu 24.04.5, ext4 persistent state |
| Fixed identities | Broker 44180:44180, Agent 44181:44181 |

## Ledger

| Stage | Result | Evidence |
| --- | --- | --- |
| Candidate and artifact verification | PASS | Five artifact digests recomputed from bytes; build A byte-identical to build B; both retained checkouts clean at the candidate; candidate is an ancestor of `main` with an identical tree |
| Retained-runtime cross-check | PASS | A third clean checkout reproduces both build reports' `lockfileSHA256` and `goModuleSHA256` |
| Target observation | PASS, with a material finding | Target carries a complete six-destination layout built from the earlier candidate `a5b16b915fba3a5a6915a41dda37cb09efc4504c`, never started, with no ledger, no journal, no lock and no process |
| Upgrade-evidence validator rehearsal | PASS, 9/9 controls | Baseline accepted; a group-writable evidence input, an impossible process state, an expired window, a proxy disagreement, a wrong repository binding and an unattested task-view digest were each refused |
| Packaging-path rehearsal | PASS | A complete v2 package (33 files) was produced from the reused builds; the independent verifier returned `valid=true` with no errors |
| Upgrade-plan rehearsal | PASS | `evaluateCleanupTargetUpgradePlan` returned `0`; the only outstanding gates were the four administrator gates |
| Real qualification matrix | **NOT RUN** | Blocked on the administrator gates below |

Claim status for every qualification case remains `not_required` / `not_evaluated`. No
case has been executed and no Permit has been issued.

## Deployment status

| Gate | State |
| --- | --- |
| Repository repair after PR #420 | merged |
| Handoff-package acceptance | not started — no package for this batch has been produced yet |
| Installation | not performed |
| Activation and Permit | not issued |
| Real qualification | not run |

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

| Evidence | Kind |
| --- | --- |
| Candidate dual-build proof and both build reports | build-host proof, reused unchanged |
| Two retained candidate checkouts | build-host proof, preserved |
| Third clean candidate checkout | packaging `sourceRoot` |
| Administrator-signed input record, 2026-10-08 | historical provenance; hash preserved, approval not inherited |
| Target host facts and dependency inventory | live target observation |
| Upgrade-evidence validator rehearsal transcript | agent verification |
| Packaging and upgrade-plan rehearsal transcripts | agent verification |
| PR #418 handoff package | historical package, retained and readable as-is |

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
