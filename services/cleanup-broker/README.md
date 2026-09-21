---
schema: openslack.document.v1
id: service-cleanup-broker
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: pr-review-merge
updated: 2026-09-21
sources:
  - design/cdd/modules/pr-review-merge.md
  - docs/architecture/control-manifest.md
---

# Cleanup Broker — Permit-only Contract and Qualification Plan

## Status and Platform Boundary

Target: a narrow Go broker for governed deletion of one merged PR's remote
branch. Configuration, lifecycle, peer mapping, v2 ledger, protocol and CLI
routing have local implementations. B3 now connects the fixed governance reader,
strict registry validator, installed TS executor and private send handshake.
An invalid/missing execution installation stays status-only, without reserving
a permit or selecting a direct transport. Complete installed qualification remains
unproven. No real GitHub deletion, installed
isolation, current-head CI completion or release readiness is asserted here.

The broker targets Linux and WSL2 with a Unix socket and OS peer credentials;
the trusted executor uses private inherited pipes and a dedicated process group. TCP is outside
this contract. Native Windows broker execution and agent client routing are
unsupported; existing Windows cleanup library/CLI regression does not imply
broker support or permit a local direct-delete fallback. A root-run fixture is not evidence that an
unprivileged agent is isolated from broker credentials or files.

## Installation and Current Entrypoint

Build the foreground entrypoint from this independent module with
`GOWORK=off go build ./cmd/cleanup-broker`. It accepts no arguments or environment
overrides for installation paths. Positive qualification additionally requires
the fixed administrator installation, independent identities and governed boot
activation; a compiled binary alone does not meet those prerequisites.

| Fixed path                                                  | Required ownership / access                                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/etc/openslack-cleanup/broker.json`                        | Administrator-owned, Broker-readable, not writable by Broker or Agent                                |
| `/usr/lib/openslack-cleanup/{node,executor.mjs,git}`        | Administrator-owned pinned installation; hashes in config                                            |
| `/usr/lib/openslack-cleanup/{sh,git-core/git-remote-https}` | Fixed execution dependencies, covered by the installation manifest                                   |
| `/usr/lib/openslack-cleanup/install-manifest.json`          | Root-owned complete installation list; its byte digest is bound by config v2                         |
| `/etc/openslack-cleanup/task-dependencies.json`             | Root-owned, scoped and time-bounded task dependency view; missing/expired evidence refuses execution |
| `/etc/openslack-cleanup/credentials/governance`             | Administrator-provided read-only governance credential reference                                     |
| `/etc/openslack-cleanup/credentials/github-app-private-key` | Separate administrator-provided deletion App key reference                                           |
| `/var/lib/openslack-cleanup`                                | Dedicated Broker UID, mode `0700`, supported Linux filesystem                                        |
| `/run/openslack-cleanup`                                    | Dedicated Broker UID, mode `0755`, no Agent write access                                             |

The socket is mode `0666` so distinct mapped UIDs can connect without joining
the credential-readable Broker group. This is not authorization: each request
must match kernel `SO_PEERCRED` and the immutable mapping. The enclosing
directory is not client-writable. Unknown peers are rejected. Administrators
must independently prove that Agent supplementary groups, sudo and Docker
access cannot bypass these boundaries.

Every startup verifies installation, locks the ledger before touching the
socket, writes/fsyncs a new `instance.json`, and begins without activation.
Only the fixed governed policy can activate the boot nonce/generation. Missing
one of an existing ledger/instance pair blocks startup rather than resetting
history. Clock rollback, configuration replacement, or changing an activated
generation stops new admission permanently for that boot.

The new ledger schema is `openslack.cleanup-ledger.v2`. Old v1 bytes are rejected
without migration or truncation. A complete intent precedes execution; a
separate fsynced send-admitted record means a request _may_ have been sent, not
that deletion succeeded. Replayed reservations never regain permission to send.

## A0/A1: Trusted Boundary

Permit-only is the approved authorization model. A task reference expresses
administrative scope, not a live claim/lease. Future Go/PostgreSQL Task Claim v2
is tracked by its [C0 contract](../../docs/architecture/contracts/task-claim-v2-c0.md)
and does not gate this route. Source-branch task dependencies still block cleanup.

Map the Unix peer UID through an administrator-owned mapping to an independent
principal, runtime UID and run. Never trust caller-supplied identity fields as
authentication. Broker configuration, mapping, ledger, installation credentials
and the pinned executor/hash must be inaccessible to the agent identity. The
request supplies no arbitrary configuration, executable path, credential,
authority URL or authorization callback. Missing or invalid prerequisites fail
closed; the agent never configures its own authority.

The ledger resides on broker-owned Linux storage, not an agent-writable Windows
mount. One exclusive process lock prevents two writers. Append records carry
sequence and integrity-chain evidence, and successful durable publication
requires file and containing-directory fsync. Corruption, truncation, broken
sequence or incompatible recovery state poisons write admission. The separate
worker journal shares the ledger lock; an existing ledger without its worker
journal refuses recovery rather than creating an empty history. These are
required behaviors, not evidence of completed filesystem qualification.

## A2/A3: Permit, Operation and Send Contract

Resolve the fixed governed authority main once and bind registry, policy and
permit bytes to that same commit and stable repository ID. A mutable local
file, mixed revisions or same-name replacement repository cannot become
authority. Require the scoped `pr.cleanup_branch_scoped.v1` action and explicit
denial of the old `pr.cleanup_branch` action; old allow never grants new scope.

One strict permit binds the authenticated subject, host/repository ID, PR node
ID and number, full ref, exact SHA, workspace, task scope reference, issuer,
broker ID/generation/boot nonce, validity window, revocation state and
`maxUses: 1`. No glob, target array or caller-provided wildcard is an equivalent
permit. The implementation-owned schema must reject unknown/ambiguous fields;
this document does not substitute for that exact parser contract.

Before a send, durably reserve the operation ID and canonical request digest.
The same operation and digest returns its stored receipt; changed bytes under
the same operation conflict; another operation cannot spend the permit again.
Consumed or reconciliation-required reservations cannot be released for reuse.
Status is read-only and must preserve attribution of unknown effects.

CLI permit, operation and status controls are typed inputs only. Agent requests
use explicit repository/remote and App authentication; neither missing broker
nor denial may activate the legacy human/direct transport route. Preserve
merged-PR, canonical-base, same-repository, protection/rules, reserved-ref,
open-PR and source-task dependency checks, followed by exact-SHA Git CAS.

After token, installation and remote lookups, the trusted transport performs
final authority, permit, subject, revocation, time and target checks immediately
before its sole send. No public callback returning an authorization boolean is
accepted. A wait during credentials/remote discovery is not permission to use
stale authorization. Failure before send must retain `attempted: false`; after
send may have started, only read-only reconciliation and outcome recording are
allowed. Expiry never erases a possible side effect or triggers another send.

## A4: Restart, Recovery and Rollback

Each broker boot creates a new nonce and begins read-only until administrator-
governed activation. Old permits do not migrate into the new boot. Existing
reservations can only be reconciled; backup restore, a clock rollback or lost
in-memory state cannot renew executable permission. V1 is single-host, not a
distributed lock or multi-host replay-prevention claim.

Close new admission before rollback, drain or reconcile admitted operations,
preserve the ledger and retain read-only status. Do not restore executable
permission by deleting records, resetting nonce/generation, reverting fields or
re-enabling direct deletion. Git CAS protects ref SHA, not an atomic transaction
with GitHub protection, authority or claim state; residual cross-system races
and same-SHA ABA must remain explicit in evidence.

## QA Plan and Evidence Classes

All cases below are **PLANNED / NOT_RUN** for the complete broker route. Tests
of individual newly implemented components must be reported separately with
their exact candidate; they do not promote these end-to-end rows to PASS.

| Classification / layer         | Required cases and observable result                                                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth / contract                | Fake local grant/registry, mixed authority commits, same-name wrong repo ID, wrong UID/principal/runtime/run, wrong target tuple/workspace/task scope, old action allow, unknown version, revoked/expired permit: zero send. A task ref alone never proves claim ownership.        |
| Ledger / concurrency           | Two broker processes contend for one lock; same operation/digest is idempotent, changed request conflicts, another operation cannot replay; one reservation and at most one send.                                                                                                  |
| Ledger / crash and storage     | Crash before/after reservation and send, fsync or directory-fsync failure, partial append, truncation, bad sequence/hash, backup restore and missing records: fail closed or reconcile, never silently reset consumption.                                                          |
| Boot / clock                   | Restart nonce mismatch, stale activation, old permits, old reserved operations, backwards clock and expired window: read-only until governed activation; historical reservations remain reconciliation-only.                                                                       |
| Workflow / final-send boundary | Revoke/expire/change authority or target while awaiting token, installation, remote or intent IO; final verification blocks before spawn. Mutating caller input across awaits cannot change owned request evidence.                                                                |
| Git / effect                   | Exact ref/SHA CAS, concurrent push, missing branch, protection/dependency blocker, lost acknowledgement, post-delete recreation and unreadable readback; no deletion of the competitor's new ref and no destructive retry on unknown result.                                       |
| OS / isolation                 | Real distinct broker and unprivileged agent identities; peer spoofing rejected; agent cannot read credentials or modify config, mapping, executor/hash, socket controls or ledger. Root-based tests are insufficient.                                                              |
| Compatibility / hosted CI      | Same-candidate TypeScript Linux/Windows checks; Go broker Linux/WSL tests; explicitly unsupported native Windows broker path refuses instead of fallback.                                                                                                                          |
| Live integration               | Administrator-provisioned dedicated GitHub target, least-privilege App, valid single-use permit, genuine successful deletion, blocked wrong targets/protected/dependent branches, repeated operation receipt and independently verified ref result. No main-repository substitute. |
| Governance / operational       | Redacted intent/outcome index, immutable candidate and config hashes, independent security review, valid human approval and PRMS delivery. CI, live qualification and release reported separately.                                                                                 |

Smoke scope is broker startup in read-only mode, authenticated status, denied
unauthorized request, governed activation, exact dedicated-target request,
durable receipt and safe restart/reconciliation. Real positive smoke remains
blocked until administrator provisioning and composed-route verification are complete.

Evidence records include candidate SHA, OS identities in non-sensitive form,
configuration/executor hashes, authority commit, permit/operation IDs, ledger
sequence, observed ref state, command exit status and test layer. Never archive
credentials, raw permit secrets or provider responses. A green mocked suite
does not prove real isolation; earlier PR #418 CI does not qualify later broker
changes. Independent review and human sign-off remain separate obligations.

## B1/B2 Local Evidence — 2026-09-21

On the dirty feature checkout based on `5bf63a573352cc42c739e943a773d675749a9456`:

- `GOWORK=off go test -race ./... -count=1` and `go vet ./...`: eight
  component packages passed. The entrypoint builds, but has no dedicated
  end-to-end daemon deployment test.
- The explicit cleanup/client/authorization/digest/CLI/workflow suite passed
  319 tests across 12 files; these are not additional independent counts on
  top of earlier subset runs.
- Full root typecheck/build and contract-family verification passed. The
  six tracked source manifests retain all 257 matching bindings.
- Independent component review found and closed registry UID drift,
  error-after-send-admission attribution, concurrent replay intent drift,
  invalid outcome/attempted pairs, and missing final source observation.
- Invoking the entrypoint in the root development session refused startup,
  as required. This negative check is not an installed distinct-UID test.
- Local Linux build and Windows unsupported-entrypoint cross-build used
  `-buildvcs=false -trimpath`. Default VCS stamping failed because Go invoked
  `git status` in `/tmp` for this linked worktree. Explicit unstamped local
  builds do not establish a signed/frozen qualification artifact or native
  Windows execution evidence.

## B3 Installation Handoff (Not Activation)

The configuration schema is now `openslack.cleanup_broker_config.v2`; v1 is
rejected, not silently upgraded. The following is a review template, not a
valid grant or a ready-to-install configuration. Replace every placeholder
with reviewed evidence; do not remove fields to bypass validation.

```json
{
  "schema": "openslack.cleanup_broker_config.v2",
  "brokerId": "qualification-broker",
  "workspaceId": "qualification-workspace",
  "uid": 21001,
  "gid": 21001,
  "peerBindings": [
    {
      "uid": 21002,
      "agentId": "qualification-agent",
      "subject": {
        "principalId": "agent:qualification",
        "runtimeUid": "administrator-registered-runtime",
        "runId": "administrator-registered-run"
      }
    }
  ],
  "allowedRemotes": ["qualification"],
  "artifacts": {
    "nodeSHA256": "<sha256-of-installed-node>",
    "executorSHA256": "<sha256-of-installed-executor>",
    "gitSHA256": "<sha256-of-installed-git>",
    "installManifestSHA256": "<sha256-of-exact-install-manifest-bytes>"
  },
  "credentialRefs": {
    "governance": "/etc/openslack-cleanup/credentials/governance",
    "githubAppPrivateKey": "/etc/openslack-cleanup/credentials/github-app-private-key"
  },
  "githubApp": {
    "appId": 1,
    "installationId": 1,
    "owner": "ADMINISTRATOR_REGISTERED_OWNER",
    "repo": "ADMINISTRATOR_REGISTERED_QUALIFICATION_REPOSITORY"
  }
}
```

The illustrative numeric IDs above are not real App, installation or OS
identity evidence. Choose distinct dedicated identities and verify group,
sudo, filesystem and Docker access before any qualification.

The root-owned installation manifest has the closed shape
`{schema: "openslack.cleanup_installation.v1", files: [{path, sha256}], network:
{httpsProxy, noProxy}}`. Include the fixed Node, executor, Git, shell and Git
HTTPS helper and every installed runtime dependency. Each file must be a
canonical ordinary file under `/usr/lib/`, not a symlink or unexpected hardlink.
The minimum five required files are not proof of the dynamic-loader/shared-
library dependency closure: installation review must inventory and verify the
actual host dependencies and their ownership. Network fields are explicit;
empty strings mean no configured proxy, never inheritance from the Agent.
Proxy URLs cannot carry credentials, a path, query or fragment.

Build the executor from the candidate root with
`bun scripts/cleanup-broker/build-executor.ts --outdir <evidence-directory>`.
Use the repository-pinned Bun 1.4.0 and a frozen lockfile installation. A toolchain
upgrade requires new clean-build artifact hashes; earlier Bun 1.3.11 evidence
remains historical and does not qualify the new candidate.
It rebuilds TypeScript dependencies and compares separate bundler processes
with fresh output locations. This checks repeatability of the same source
inputs, not two independent clean Git checkouts. Record the reported bundle
hash, lockfile, build-tool version and actual installed Node version (Node
must satisfy the pinned dependency engine requirement). No installer, credential
provisioning or policy activation is performed by this command.

The fixed task view uses `openslack.cleanup_task_view.v1`, exact `workspaceId`,
`repository`, stable `repositoryId`, RFC3339 `notBefore`/`expiresAt`, and an
explicit `tasks` array of `{taskId, issueNumber, state}`. Accepted states are
`pending`, `claimed`, `in-progress`, `completed`, `released`; the first three
block linked source tasks. The administrator must attest the controlled view's
scope and completeness. Never generate an empty view from a fresh temporary
checkout. This is still not a global task reverse index. Changes require a new
boot/activation, not hot replacement during a send.

After preparation, start the daemon under its dedicated UID, record the actual
new boot nonce, then activate that exact instance through the independent
governance configuration process. Do not copy old permits to the new nonce.
All credential material stays in administrator-provisioned files and private
worker pipes; the configuration, intent, receipt and build reports contain no
tokens or keys.

## B3 Send and Process Evidence Boundary

The worker blocks on private FD3 until its process identity and group have
been durably recorded; FD4 carries bounded control messages, never stdout.
After transport preparation, the sending worker blocks again. The Broker runs
one independent, non-sending preview of the real PRMS resource gates, then
reacquires governance, checks the pinned task view's validity window and writes
the send-admitted observation before granting a single push. No token or remote
is prepared again by the sending worker after that grant. Resource reads remain
non-atomic with the external Git effect; this does not remove cross-system races.

The separate worker journal uses `openslack.cleanup_worker_ledger.v1` records.
The ledger and this journal must remain together. An old deployment missing
worker history is refused, not reset. New boots never resume worker sending.
Historical process groups are only inspected, never killed using a bare saved
PID. An unprovable residual group stops admission. On shutdown the daemon stops
HTTP admission, drains/kills and waits for owned workers, completes handler
receipts, then releases the lock. Permanent recovery poison deliberately keeps
the stopped process holding its lock; live status HTTP is unavailable during
that shutdown state. Administrator recovery must preserve both journals and
establish group absence before a new activation.

Local fixture tests and the actual-bundle refusal probe remain distinct from
an installed distinct-UID test, a successful live GitHub deletion, hosted CI or
human approval. Their exact current results belong in the QA evidence ledger;
the earlier B1/B2 counts above are retained as historical evidence only.

Production is still status-only: B3 pinned worker, inherited-pipe handshake,
final Git transport fence, child shutdown/reaping, and the complete authority
reader/registry/runner composition remain **NOT_RUN / unimplemented**. Actual
OS isolation and GitHub qualification remain unproven. No commit, push, new
hosted CI, human approval, or merge is asserted by these local results.
