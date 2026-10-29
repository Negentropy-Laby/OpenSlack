---
schema: openslack.document.v1
id: architecture-adr-harness-closed-loop-repair
status: Approved
authority: canonical
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-10-27
sources:
  - design/cdd/workstreams/agent-runtime-and-aby/README.md
  - docs/architecture/components/agent-runtime.md
  - docs/architecture/integrations/aby-bridge.md
---

# ADR-0003: Preserve governed execution and evidence across Bridge failures

## Status

Accepted for the exact implementation scope below by the requesting maintainer's
explicit chat decision. This decision grants no execution identity, PR approval,
merge or release authority.

The frontmatter `Approved` value is the document-schema status for this accepted
ADR; it is not a GitHub `APPROVE` review or permission to approve the PR.

## Acceptance Record

The requesting maintainer replied: “正式接受该精确 ADR 及所列实施范围”.
The reply was received through the user question response to
`call_44f7b3a5cd2c46c88eb3427c969f1a9b`; it is a chat decision, not an
authenticated GitHub review or an inferred human account identity.

- Accepted Proposed SHA-256: `5efa47bd8960c6e3aead168c01b10a84c83f514bf572b4c19bfc8aa1d2b01f63`.
- Accepted Proposed size: 16,248 bytes.
- Recoverable original: `.openslack.local/harness-evidence/20261024/repair-426-20261026T0756Z-gg9PtI/ADR-0003-DRAFT.md`.
- Original collection/decision observation: `2026-10-27T00:49:27+08:00`.
  This is the executor's observation time, not a fabricated message-server timestamp.
- Scope: this exact ADR's listed repairs on existing Draft PR #426; no subject
  provisioning, approval, merge, release or permission expansion.

The original Proposed bytes remain preserved. This acceptance record does not
reclassify historical implementation or test evidence as newly executed.

## Date

2026-10-27 (Asia/Shanghai).

## Technology Compatibility

The affected product is OpenSlack, not the CDD Source library. TypeScript remains
the host/plugin implementation language. The only native addition is a private,
stateless Windows x64 process supervisor inside the external plugin package.

| Input | Fixed compatibility requirement |
| --- | --- |
| OpenSlack repair starting point | `e0633550ae3e38e26350b79eb347ede52a99a4a2`, PR #426 |
| Harness | Unmodified `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`; SDK/dsh `0.2.1-rc.3` |
| Plugin process | Node `24.18.1`, Bun `1.4.0` build orchestration |
| Supervisor | Go `1.26.5`; independent module, `GOWORK=off`; no service/HTTP/database |
| Windows bindings | `golang.org/x/sys v0.25.0`, matching the existing repository pin |
| Public process APIs | Node child-process diagnostics; Win32 suspended creation, Job Objects, handle allowlist and process wait |
| Knowledge risk | Incomplete: no project stack VERSION original is available; exact installed inputs and official API references must be verified, not inferred from training knowledge |

The stock MCP 2.2.0 transport's public stderr stream exists before connection;
drain it before initialization. Do not use SDK private fields or patch Harness.

## ADR Dependencies

- Depends on: no new service architecture. Existing Agent Runtime governance,
  task/principal intersection, one-owner state and worktree contracts remain.
- Enables: the durable-control, full-evidence chunking, provider-wide strict wire
  and Windows owned-tree repair packages in PR #426.
- Blocks: only implementations depending on these new contracts until exact
  acceptance or a valid scoped exception; independent local fixes continue.
- Prior ADRs remain at their actual statuses; this record does not accept them.

## Context

The reviewed starting point can strand an admitted task before execution, lose
acknowledged reports to another writer, reject valid large tool evidence after
an effect, and terminate only the peer rather than its SDK descendants. An
in-memory map, signal request or successful prompt receipt proves none of
governed authorization, resource quiescence or independently verified results.

The requesting maintainer selected full evidence with bounded chunking,
provider-wide strict validation and a minimal plugin-owned Windows supervisor.
All changes remain on original Draft PR #426. There is no Harness/Aby patch,
identity bootstrap, permission expansion, approval, merge or production operation.

## Decision

### Admission ownership and stop facts

New admission routes carry an owner generation, admitted-at and absolute
deadline plus run/request routing bindings. The canonical Harness execution
adds optional lifecycle metadata with owner, deadline, real governed
plan/execution identity and phase: awaiting_confirmation, authorized, started,
stopped_before_start or indeterminate. Completed/verified remains the existing
canonical outcome, not a second completion state.

Register control before any publication await. Only a newly owned admission,
after reading matching durable succeeded confirmation, may start. Commit started
before any SDK/peer/tool-capable process. Preparation may create the isolated
worktree and bindings but must not start such a process. Resolve all confirmation
outcomes, deadlines and cancellation through one trusted settlement path.

Missing legacy metadata never implies authorization or zero execution. A crashed
owner is not proven stopped by an empty map or PID alone. Historical routes are
not reconstructed into executable control. Same logical key returns the prior
observation; another attempt requires a newly approved idempotent intent, not a
different requestId. A route without canonical run is an admission observation,
never a fabricated pending AgentRunState or visibility anchor.

An immutable stop-intent under the existing admission directory binds run,
request hash, owner generation, fixed reason and request time. Exclusive atomic
publication does not require the canonical state lock. Every subsequent tool,
report, start and completion guard checks it. It proves stop was requested, not
that an already admitted effect ceased. Unknown in-flight operations remain so.
An unreadable/damaged canonical run is preserved, never rebuilt by observation.

### State and transcript ownership

One short synchronous cross-process RunStore transaction owns read/modify/write
and intended transcript events. Derived counters and nested patches are computed
inside it. Reject asynchronous callbacks and reentry; bounded lock contention
must not delete orphan locks. Remove the old overlapping external run locks.

Validate and secret-scan state and events before writing, append/fsync events,
then temp/fsync/rename the canonical snapshot for every provider. This is NOT an
atomic two-file commit: partial persistence becomes indeterminate, preserves
evidence and cannot be replayed or promoted to success.

The durable transaction lock records run/transaction/owner identity before the
first append. New snapshots contain a monotonic persistence revision and the
committed transcript-byte watermark. A reader rejects an in-flight/orphan lock
or a stable transcript length differing from that watermark; it never treats
the earlier snapshot as a current writable/completed result. Retain the lock and
unpublished temporary on unconfirmed publication. Only the owning fully committed
transaction removes its lock. Historical records without these fields remain
legacy evidence, not newly checkpointed or automatically repaired. This detects
crashes between append and snapshot without a second task-state database.

### Strict wire and bounded full evidence

Every provider validates UTF-8, JSON, envelope shape, run/session identity,
terminal uniqueness, data/usage and truncation. Provider shutdown policy cannot
disable validation. Aby retains one absolute maximum 1-second completion grace
from its execution deadline; Harness has no such business grace. Heartbeats
neither consume the business queue nor renew a deadline. All other queueing is
byte-bounded/backpressured. Closing rejects active waiters and handles stdin
errors; primary failure kinds survive deadline and shutdown diagnostics.

Keep ordinary wire frames at 1 MiB. Only explicitly negotiated
`chunked-json.v1` allows a complete inner envelope up to 16 MiB, split into
256 KiB decoded chunks (at most 64). Each outer chunk repeats version, session,
correlation, messageId, index/count, total bytes and SHA-256. Require canonical
Base64, exact count/length/order and digest, fatal UTF-8 and strict inner
validation before any business delivery or terminal counting. Forbid nested,
handshake, unnegotiated, replayed and cross-run chunking. Serialize complete
messages and admit at most one reassembly per direction; business queue budget
is 32 MiB plus one 16 MiB reassembly. Close drains the private control channel
without allowing further business effects. Older Aby peers receive no invented
extension support. Capabilities are a copied intersection with trusted advertised
support, never an echo or an authorization substitute.

Full evidence means complete permitted, redacted JSON values and tool-result
metadata, not original JSON whitespace. Preserve the model's input separately
from host-resolved target evidence; do not mutate file_path in place. Store the
canonical full call/result once in JSONL; lifecycle/reconciliation only reference
call IDs and counters. Keep run.json at its existing 512 KiB bound. Parse tool
evidence strictly and incrementally, not through the old 8 MiB bulk reader.

The Harness transcript budget is 64 MiB, including a protected 64 KiB terminal
and failure reserve. Cross-process pre-effect reservations bind public callId,
tool, original input digest, real target, run and generation. Early SDK call
notifications wait for that reservation; fs-intent rechecks reuse it. All report,
progress and terminal writers share the quota owner. Reserve exact serialized
call plus bounded result bytes; release unused bytes only after result persistence.
Write content and each Edit old/new value are bounded at 1 MiB UTF-8. Use actual
before/proposed text and public output render/presentationMeta for read-only
capacity preview, without copying private diff/SDK code or replacing stale-write
guards. Unsupported/unprovable capacity rejects before effects; unexpected
post-effect result/I/O failure remains unknown, never truncation or success.

Capacity preview reads before text via bounded public streamText, compares
opaque public FsVersion before/after and emits no fs/observed event. Before and
proposed text are each at most 1 MiB UTF-8. Count literal-edit matches and safely
compute the prospective byte count before constructing any replacement string;
reject expansion/overflow first. In the actual fs-intent hook, obtain the original
next() intent: write requires the same preview version in replaceIfVersion (or
a missing-file preview paired with createIfAbsent); edit requires its original
`{ version: FsVersion }` to match the preview version. Undefined/unprovable or changed
intent rejects; do not synthesize a new version or refresh the native policy.
The native backend's existing critical-section CAS protects the final window.

### Owned Windows process tree

The private supervisor is included in plugin artifacts, pack allowlist and
deployment digest. Trusted deployment chooses its fixed Node/peer command,
argv, binary identities and physical roots; model/MCP input cannot select them.
Do not expose a public application bin or general process tool.

Create/configure the private noninherited unnamed Job first, with
KILL_ON_JOB_CLOSE and without breakaway. Create the peer suspended using public
STARTUPINFOEX/PROC_THREAD_ATTRIBUTE_JOB_LIST so association occurs at creation,
not a crash-prone separate post-create assignment; verify Job association before
resuming the retained primary-thread handle. Use the pinned x/sys CreateProcess
interface, not exec.Cmd followed by thread enumeration. Unsupported Job-list or
nested-Job setup fails before child execution, with no fallback. The supervisor
stays outside its child Job. The explicit inherited-handle list contains only
child stdin/stdout/stderr, never Job or control stdout handles. Windows 10+ and
Server 2016+ are required for this path; the reviewed Windows-2022 target qualifies.

Only the supervisor frames stdout: child bytes are wrapped in canonical Base64
bridge-bytes records of at most 64 KiB raw data, distinct from supervisor
receipts. Host decoding restores child bytes before Bridge parsing; child output
cannot forge a supervisor receipt. Stderr is drained without retaining secrets.

On host EOF, first close peer stdin, then use one nonrenewable 30-second cleanup
deadline: at most 25 seconds for graceful drain and the remaining at least
5 seconds for forced termination and observation, not another 30-second budget.
A receipt requires root process-handle signaled, Job ActiveProcesses=0,
and both child output pumps at EOF/drained. Root exit 0 with descendants is not
clean completion. TerminateJobObject at expiry; forced remains explicit. Missing
or overdue receipt is unknown; forced-but-stopped cannot be business success.
If the final cutoff expires, retain unknown and close the Job ownership handle;
late exit facts may be appended to evidence but cannot retroactively create success.
The unique Job handle closing on supervisor crash provides the kill-on-close
backstop. No fallback to unsupervised Node is permitted after assignment failure.

Execution cutoff and cleanup cutoff are separate. No new model/tool action may
start after execution cutoff. Principal total lifetime limits must include cleanup
allowance rather than silently adding 30 seconds. Identity/limit provisioning is
separate from this decision and is not inferred from registry declarations.

### Recovery and delivery

Historical reconciliation reads task/source/evidence bindings without requiring
a currently active execution lease. Return historical confidence separately from
current execution eligibility. Expired leases still deny all execution/report/
accept writes. Observation never repairs locks, writes state, starts SDK or prompts.

Native Windows and WSL qualification remain separate. Prepare pinned Go before
Windows plugin build, and verify the packed helper and actual stopped process
tree. Default no-checkout tests remain usable, while explicitly requested complete
compatibility/inventory/CI must fail if prerequisites are missing. No skip,
retry or legacy validation fallback may manufacture qualification.

## Alternatives Considered

- Delete stale admissions/retry: rejected; it can duplicate unknown effects.
- Digest-only tool bodies or a larger unbounded frame: rejected by the chosen
  full-evidence requirement and bounded-memory contract.
- Keep legacy weak wire gates: rejected by the explicit all-provider decision.
- EOF/taskkill alone or borrow the sealed-worker supervisor: rejected; neither
  proves this plugin's owned tree, and the frozen worker boundary stays intact.
- Blob store, daemon, generic reconcile CLI or global index: not necessary here.

## Consequences and Performance

The host owns all canonical state and acceptance. Chunking adds serialization and
base64 overhead; strict streaming and byte limits bound allocations, not measured
latency. Single-phase immutable observations may remove duplicate hashes; live
permission/task/lease checks after awaits remain. New native build/pack and crash
tests are necessary costs, not a new operational platform. This is cooperating
runtime containment, not a claim to sandbox arbitrary malicious native programs.

## CDD Requirements Addressed

- Agent Runtime: fail closed, per-run redacted evidence, pre-action authorization,
  worktree preservation, independently validated completion and external runtime
  not owning OpenSlack governance.
- Collaboration/MCP: governed immutable intent, actor/workspace binding and
  projection-only result readback without synthetic authority.

## Migration and Validation

Append repair commits only to #426. Old records/logs/identities/worktrees retain
their bytes. Test every crash window, two-process writer contention, stop barriers,
lease-expired history, chunk replay/limits/metadata, quota before native effects,
Windows three-generation Job shutdown and actual legacy Aby strict interoperability.
Bind logs to exact tree/platform/dependency inputs. All local, hosted, real-model,
human acceptance, ADR acceptance and PR approval remain separate claims. This
record accepts the design only; implementation regressions and qualification
remain pending until their own exact-candidate evidence is recorded.

## Related References

- [Agent Runtime CDD](../../../design/cdd/workstreams/agent-runtime-and-aby/README.md)
- [Implementation contract](../components/agent-runtime.md)
- [Aby interoperability contract](../integrations/aby-bridge.md)
- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Windows process creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Node child process](https://nodejs.org/download/release/v24.18.0/docs/api/child_process.html)
