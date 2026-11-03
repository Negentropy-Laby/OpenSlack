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
BLOCKED live gate, or **1** for invalid inputs/source inspection. It reports the
working-tree source hash separately from HEAD and never calls GitHub or a model.
Uncommitted preparation bytes are not a frozen execution candidate.

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
  window; no catch-up rows are fabricated. No Go metric source is wired yet.
- `evidence.ts`: hashes, strict evidence primitives and honest NOT_RUN/BLOCKED
  layers. It does not publish or promote any result.

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
