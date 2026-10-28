---
schema: openslack.document.v1
id: architecture-adr-run-storage-recovery
status: Approved
authority: canonical
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-10-28
sources:
  - design/cdd/workstreams/agent-runtime-and-aby/README.md
  - docs/architecture/adr/adr-0003-harness-closed-loop-repair.md
---

# ADR-0004: Isolate unavailable runs and explicitly retire abandoned storage ownership

## Status

Accepted for the exact scope below by the requesting maintainer's separate chat
decision. The document-schema Approved status is not a GitHub APPROVE review,
production-data repair authorization or execution qualification.

## Acceptance Record

The requesting maintainer replied: “正式接受该精确 ADR 及实施范围” to question
`call_11f295e6bae74b9b99f183380e29a88b`. This is a separate chat decision, not an
authenticated GitHub review or inferred human account identity.

- Accepted Proposed SHA-256: `286f411c97d85bb00201e35bdd36736625e0bff557b7afd2ebbc144a2c1b1bce`.
- Accepted Proposed size: 14,430 bytes.
- Recoverable original: `.openslack.local/harness-evidence/20261024/repair-426-20261026T0756Z-gg9PtI/r36-20261028/ADR-0004-PROPOSED.md`.
- Acceptance observation: `2026-10-28T14:58:22+08:00` (executor observation, not a
  fabricated message-server timestamp).
- TypeScript/storage specialist and Full-mode TD recommendations covered that
  exact Proposed revision. Their static recommendations are not runtime PASS.
- Scope: R36 repairs on original Draft PR #426; recovery writes only on isolated
  fixtures this round. No identity, real historical-data repair, PR approval,
  merge or release authority.

The exact reviewed original is preserved separately; adding this acceptance
record does not reclassify historical code or tests as newly verified.

## Date

2026-10-28 (Asia/Shanghai).

## Technology Compatibility

| Input | Requirement / evidence limit |
| --- | --- |
| OpenSlack starting candidate | PR #426, `9f33f17a7ed4bfd9ec8956894440dd7c4e7a3d8d`; base `184adb088c6157ceec148061a6b8cef5f8444377` |
| Host | Strict TypeScript 5.9.3, qualified Node 24.18.1; Bun 1.4.0 orchestration |
| External runtime | Unmodified Harness `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`, SDK/dsh 0.2.1-rc.3 |
| Domains | Data storage, CLI, authorization, recovery and process observations |
| Public interfaces | Node fs, perf_hooks and child_process; Linux procfs; Windows local CIM |
| Knowledge risk | Incomplete: no project stack VERSION original is available. Verify exact public APIs and installed inputs; do not infer LOW risk. |
| Verification | Process-crash windows, bounded reads, native Windows and Linux/WSL observations; no arbitrary power-loss durability claim |

## ADR Dependencies

- Depends on Accepted ADR-0003. Its accepted Proposed original is 16,248 bytes,
  SHA-256 `5efa47bd8960c6e3aead168c01b10a84c83f514bf572b4c19bfc8aa1d2b01f63`.
  Its retained acceptance-record revision is 17,224 bytes, SHA-256
  `90e25063fbea23a4db08b9a6a5dc82ff9129b6558010fd0a7693a10e9878e90b`.
- Enables only the R36 shared create/append discipline, versioned intents,
  isolated observations and single-run maintenance path in original PR #426.
- Changes the prohibition on removing abandoned locks only for the explicit,
  authorized, proven-abandoned procedure below. Automatic lock deletion remains
  forbidden. ADR-0003 and historical bytes are not overwritten.
- Blocks directly dependent implementation until exact acceptance or an existing-
  governance scoped exception. No new registry or Foundation-ADR count gate.

## Context

Create does not share append/update ownership. A crash can leave only metadata,
or appended events without a matching snapshot. Strict reads correctly reject
uncertain evidence, but one unreadable run currently fails the entire list.
An operator cannot narrowly retire proven-abandoned storage ownership without
inventing execution certainty or replacing history.

The selected policy is isolation plus explicit recovery, not automatic replay.
The existing `agent-runtime` command group is the sole new operator surface.

## Decision

### One ownership discipline

An internal synchronous, non-reentrant `withRunOwnership` owns create, standalone
transcript append, transaction updates and recorder writes. Acquire ownership
before deciding whether the namespace contains a canonical run or legacy
transcript-only evidence. All writers check a maintenance barrier after acquiring
ownership and immediately before their first publication. A held or orphan lock
is never deleted based on age, an empty map, a PID alone or a retry.

Encode and secret-scan input before publication. Preserve finite contention waits,
synchronous publication guards and all live execution restrictions. Historical
transcript-only appends remain possible under the same lock; create must not
overwrite that namespace. Canonical appends advance the committed watermark.

### Versioned publication intent

New persistence metadata binds schema version 2, creation ID, transaction ID and
metadata SHA-256 in addition to the existing revision and transcript-byte
watermark. A lock binds run, transaction, owner generation, operation and optional
OS writer-birth witness. Before the first canonical write, persist an immutable
intent with the exact temporary names, base revision/state digest/watermark,
target state and metadata digests, and appended byte length/digest.

Creation prepares exclusive mode-0600 temporary metadata and state, fsyncs each,
then publishes the complete intent. Exclusively link metadata first and canonical
run last. Never overwrite an existing run, metadata or transcript namespace.
Prompt, initial prompt and system reminder are excluded from metadata.

Updates validate and scan under ownership, append/fsync intended transcript bytes,
then temp/fsync/rename the snapshot. This is not a two-file atomic commit. Ordinary
success requires confirmed publication and required cleanup. Any uncertain stage
retains lock, intent and temporary evidence and returns a stable incomplete or
indeterminate result. No rollback, replay, fake success or implicit retry.

This decision covers process-crash consistency. File fsync plus link/rename does
not claim arbitrary power-loss durability; directory-persistence guarantees need
their own implementation and platform evidence before such a claim.

Legacy records retain their original bytes and legacy semantics. Missing version,
intent or writer witness is unknown, never a synthesized version-2 authorization.

### Pure observations and strict execution reads

`RunObservation` is `ready` with strictly validated state, `missing` without a run
anchor, or `unavailable` with only run ID and a stable safe reason such as locked,
creation-incomplete, corrupt, unsafe or persistence-unconfirmed. Validate every
field consumed by sorting/projection; parsed JSON and matching run ID alone are
insufficient. No observation constructs a sweeping store or writes any file.

Detailed lists retain healthy sorted records plus unavailable entries. Untrusted
agent/status fields cannot filter away unavailable entries or attribute them to
the requested agent. Failure to read the base directory is a storage issue, not
an empty list. Existing get/list compatibility is observational only; migrate
execution, reporting, start and completion decisions to strict APIs.

MCP activity still requires an existing visible event anchor. Its optional safe
read-status projection cannot invent pending/completed state or execution
permission. Reuse package-owned storage guards with the caller's error contract.

Waiting accepts a finite duration and optional signal: default 1,000 ms, honor a
longer explicitly supplied finite budget, use one monotonic local deadline and
reject Infinity. Persistent UTC task/claim cutoffs remain independent deny bounds.

### Narrow maintenance authority and inspection

The only CLI additions are:

```text
openslack agent-runtime repair-run <runId> --format json
openslack agent-runtime repair-run <runId> --write --inspection-sha256 <digest>
```

Preview is pure, bounded and package-owned: no Store constructor, sweep, archive,
barrier or process execution. The inspection binds the physical workspace/run,
bounded exact file membership (including unexpected entries/hardlinks), file/FD
identities, all relevant bytes/digests, intent consistency and resource uncertainty.

Write requires a trusted, nominal package maintenance capability scoped to this
workspace, run and inspection. An injected host authorization port supplies it;
the stock unconfigured CLI denies write. Flags, hashes, caller JSON and filesystem
possession do not grant authority. No new identity, registry, policy or approval
mechanism is introduced by this command.

After authorization, exclusively publish a maintenance barrier, then re-read the
entire inspection. Bind the new barrier separately; it is the only new entry
excluded from the preinspection CAS. Archive exact before-bytes and manifest in
a private exclusively created sibling recovery directory outside the inspected
canonical run membership. Confirm the recoverable archive before changing any
original. Copy bytes, never mutable hardlinks. Unexpected links or unbounded
membership remain unavailable instead of recursively collecting other data.
Archive failure, inspection drift or lock identity change forbids
further publication. A repair crash leaves its barrier and evidence intact.

The barrier fences new writers, not old binaries. Older storage writers must be
offline before upgrade or maintenance; version-2 fencing is not retroactive.

### Prove the storage writer exited

An internal read-only OS port lazily records and caches the current writer's
birth witness on first version-2 write. Failure does not block ordinary storage;
it makes later maintenance write unavailable. Capture the cached witness before
entering the short run critical section, not while holding its lock.

- Linux/WSL: boot ID, PID-namespace identity, UID, PID and `/proc/self/stat` start
  time (field 22). Preserve tick/identity integers as strings, not rounded numbers.
- Windows: bounded fixed local PowerShell/CIM projections of this Node PID's
  `Win32_Process.ProcessId` and `CreationDate`, plus local OS `CSName` and
  `LastBootUpTime`. Do not read command lines, enumerate other tasks, query remote
  hosts, inspect credentials or accept a caller-selected command/filter. Request
  only those CIM properties at the query, never select all then redact.

The maintenance reader re-queries the same host/boot/namespace scope. A matching
live birth denies retirement. An absent PID or a different birth proves that
specific old writer exited only within that successfully verified scope. Errors,
permission failures, scope changes and legacy missing witnesses are Unavailable.
Linux absence also requires the same verified writer UID and process-visibility
scope, or an independent successful scoped absence proof. ENOENT under hidepid or
other unproven filtering is not a death witness and remains Unavailable.
Recheck owned lock FD/path identity, bytes and inspection CAS around the probe.
Linux stat parsing must tolerate spaces and `)` in the process comm field.

This proves storage-writer quiescence, not SDK descendant shutdown. Unknown child
resources or in-flight effects remain unknown; no signal or self-reported JSON
converts them to stopped. This is cooperating-process integrity, not containment
against a malicious writer with the same OS privileges.

### Allowed recovery outcomes

| Evidence | Permitted maintenance outcome |
| --- | --- |
| Exact intent, target snapshot/metadata digests, complete committed transcript prefix and append range, watermark and strict JSONL all match | Preserve the existing committed result and retire proven-abandoned ownership; never newly grant verification. |
| Partial create/update reconstructable from the bound intent, with a safe non-executable outcome | Publish only failed/indeterminate evidence; never complete a pending creation into an executable receipt. |
| Missing legacy proof, unexpected files/links, ambiguous ranges or damaged/unreconstructable bytes | Keep isolated and Unavailable, with originals and barrier preserved. |

Any authorized changed result has a bound recovery receipt; prior evidence is
archived unchanged. Never restore execution eligibility, delete admission, spawn
SDK, prompt, re-dispatch or replay a tool to resolve uncertainty. This repair batch
exercises only isolated fixtures; real historical-data repair needs separate exact
authorization and resource-owner coordination.
The canonical AgentRunStatus vocabulary is unchanged: indeterminate is bounded
uncertainty evidence on a non-executable failed outcome, not a new runnable status.

## Alternatives Considered

- Automatic TTL/PID unlock: rejected; age and PID reuse do not prove quiescence or
  absence of effects. It violates the selected no-replay policy.
- Roll back or overwrite the namespace: rejected; it discards durable evidence,
  can mix metadata/state owners and may hide unknown effects.
- Replace storage with a new database/journal service: rejected as unnecessary
  expansion. Immutable bounded intents and explicit maintenance address this scope.

## Consequences and Performance

Healthy queries survive isolated bad records without weakening strict execution
reads. Explicit recovery remains deliberately unavailable when proof is missing.
Intents, archives and a first-write OS probe add work; no latency claim is made.
Do not add automatic evidence cleanup or a global repair index. Keep live checks
after necessary awaits, nanosecond descriptor checks and acknowledged-event fsync.

## CDD Requirements Addressed

- Agent Runtime design principles 2–5: fail-closed, auditable per-run evidence,
  permission boundaries and preservation of isolated work.
- Agent Runtime data model/edge cases: run metadata, transcript, corrupt inputs
  and provider failure must not manufacture execution or completion authority.
- ADR-0003 state ownership/recovery: one canonical owner, immutable historical
  bytes, separate historical confidence/current eligibility, no replay on restart.

No new TR IDs or project-stage status is invented by this decision.

## Migration and Validation

Append only to original Draft PR #426. Preserve old records, ADR-0003, logs and
worktrees. Test every link/unlink/fsync/rename/crash boundary and two-process
create/append order; retain RED/GREEN against exact source trees. Cover healthy
plus locked/mismatch/invalid-UTF8/unsafe lists, finite wait/abort, zero-write preview,
live writer, PID reuse, unavailable witness, inspection drift, archive failure and
repair crashes. Prove no replay, new prompt or promotion of unknown success.

Complete exact-candidate independent code/QA review and applicable Linux/native
Windows validation. Local, hosted, real-model, maintenance authorization, human
acceptance and PR approval remain separate. Green tests do not accept this ADR.

## Related Decisions

- [ADR-0003](adr-0003-harness-closed-loop-repair.md)
- [Agent Runtime CDD](../../../design/cdd/workstreams/agent-runtime-and-aby/README.md)
- [Agent Runtime component](../components/agent-runtime.md)
