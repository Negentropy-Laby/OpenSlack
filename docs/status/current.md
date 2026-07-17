---
schema: openslack.status.v2
source_of_truth: true
supersedes:
  - phase-1-prehardening
---

# OpenSlack Current Status

## Repository

| Field | Value |
|-------|-------|
| Remote | `https://github.com/Negentropy-Laby/OpenSlack` |

## Modules

| Module | Phase | Lifecycle | Maturity | Declared Operator Baseline | External Blockers | Evidence | Notes |
|--------|-------|-----------|----------|----------|-------------------|----------|-------|
| Self-Evolution Kernel | 1.6 | ACTIVE | LOCAL_READY | CONFIGURED | signed_v0_1_0_release_pending<br>clean_machine_release_capstone_pending | commit:0015b3be26dbe613b941acb515f8e5ac2e2a6319<br>test:packages/plugin-api/src/__tests__/schema-parity.test.ts<br>commit:6ba8b8240a2e898af70fffa5cd4d5e0c5ca89889<br>test:packages/plugin-host/src/__tests__/host.test.ts<br>test:packages/plugin-host/src/__tests__/installed-host.test.ts<br>test:packages/plugin-host/src/__tests__/loader.test.ts<br>test:packages/plugin-host/src/__tests__/lock.test.ts<br>test:packages/plugin-host/src/__tests__/source-invariants.test.ts<br>test:packages/sdk/src/__tests__/define.test.ts<br>commit:0a44aea82f096014646884b27a9f1b091c75f698<br>test:packages/plugin-testkit/src/__tests__/checker.test.ts<br>test:packages/plugin-testkit/src/__tests__/eval-contract.test.ts<br>repo:.openslack/self/eval_suites/plugin/EV-PLUGIN-001.yaml<br>commit:ae04404ddb548da8019754561c11a357ae2b794f<br>test:packages/kernel/src/self/core/__tests__/classify-pr.test.ts<br>repo:.openslack/self/eval_suites/golden | Stable release verification is available from the installed CLI and requires an out-of-band trusted Ed25519 public key; archive, SBOM, provenance, signature, identity fields, and subjects are verified without a source checkout or Bun. The private plugin preview now provides a zero-runtime-dependency manifest contract, typed SDK helpers, a deterministic G1-G17 manifest/lock testkit, and an instance-scoped Red host with strict exact-byte loading, deterministic integrity lock, independent capability/target policy, atomic per-kind registries, required audit writes, and blockers-only bundled PRMS normalization. Testkit reports are authoring diagnostics only and always require independent Host reauthorization. The nested self plugin run proof loads locked workspace aliases before seal only for that route, keeps SHADOW visibility non-executable, and canonicalizes ENFORCE plans through the existing Operator registry using composition-injected evidence and policy. Workspace and installed plugins remain declarative and non-executable; public npm embedding and dynamic product-surface registration remain later roadmap stages. |
| GitHub Issues Task Loop | 1.7 | ACTIVE | LOCAL_READY | NOT_CONFIGURED | clean_machine_bot_delivery_smoke_pending | commit:ae04404ddb548da8019754561c11a357ae2b794f<br>test:packages/delivery/src/__tests__/service.test.ts<br>test:packages/github/src/__tests__/watch-daemon.test.ts<br>commit:ca3e418b5b338a645e07b2f24f2dd4598b925101<br>test:packages/github/src/__tests__/app-installation-diagnostics.test.ts | GitHub Issues task loop active with typed task creation, dry-run repair, Phase 4 watch daemon, installation-scoped GitHub delivery, and strict claim heartbeat/review/complete transitions. The watch daemon now durably accepts Issue, push, PR, review, and check observations through an atomic lease-backed queue with bounded attempts, exponential backoff, retention, compaction, restart recovery, and per-route idempotency/completion. The governed GitHub App manifest subscribes to Issue, push, pull-request, pull-request-review, check-run, and check-suite events and requests checks read. App-JWT diagnostics compare accepted installation permissions/events against that contract, while installation tokens are used only to prove repository accessibility; setup and doctor report stable reauthorization, subscription, scope, and ready codes with GitHub's management URL but never perform administrator changes. PR/review/check delivery proves access to the event repository and refreshes live state through that explicitly bound client; scope mismatch fails closed without workspace-repository fallback, and review observations remain non-authoritative. Claim lifecycle operations verify structured owner evidence and postconditions, fail closed on partial GitHub state, and provide an idempotent recovery command without republishing a PR. Delivery publishes HEAD and a draft PR through the same GitHub App token, disables host credentials and hooks, synchronizes remote/PR SHAs, and returns AWAITING_GATES evidence for PRMS. Read-only installation-scope diagnostics and a preview-first temporary-ref push/delete probe verify selected-repository access and contents write capability before first delivery. |
| Operator Interface | 2A/2B/2C | ACTIVE | LOCAL_READY | NOT_CONFIGURED | model_endpoint_not_configured<br>clean_machine_onboarding_smoke_pending | commit:ae04404ddb548da8019754561c11a357ae2b794f<br>test:apps/cli/src/__tests__/setup-onboarding.test.ts<br>test:packages/operator/src/__tests__/executor.test.ts<br>test:packages/operator/src/__tests__/tool-registry.test.ts<br>test:scripts/release/__tests__/verify.test.ts<br>commit:ca3e418b5b338a645e07b2f24f2dd4598b925101<br>test:apps/cli/src/__tests__/github-app-diagnostic-command.test.ts | Structured planner active. Webhook and Slack chat adapters active with actor mapping. PRMS chat cards and action confirmation active. The typed Operator action registry is instance-scoped, preserves the closed 30-action built-in default, accepts explicit planner/executor injection, and canonical-revalidates frozen PlanSteps at execution. The CLI application composition root constructs one sealed PluginHost and instance-scoped Operator action, LLM-provider, conversation-store, and plugin-action bindings per process. Its host target catalog exposes only the audited bounded github.metrics returned-item count under the exact github.issues.read capability; SHADOW plugin actions remain visibility-only, while ENFORCE proof plans are rebuilt through the same canonical registry before execution. All other built-ins and all unconfigured plugin authority remain fail-closed until complete behavior contracts, policy, activation evidence, and a durable audit sink are explicitly composed. LLM-first intent routing with deterministic keyword fallback, setup report, and 24h pending plan store active. Session-based conversation memory with multi-turn context resolution and progressive clarification. Doctor --format plain for non-technical output. Conversation-first TUI workbench with Ask OpenSlack, Operator recommendation cards, workflow draft-first cards, profile sync recommendations, and subagent mention dispatch. TUI setup report view and PR doctor view via --format tui. Versioned Windows x64 and Linux x64 archive builds embed the CLI, workflow assets, native keychain binding, build metadata, SBOM, checksums, and provenance; native build and unpacked smoke are enforced by the release matrix. The installed CLI verifies stable release artifacts and trusted signatures without a source checkout, Bun, or Node.js. Agent Runtime credentials can be previewed and imported atomically into the native keychain without writing secret values to workspace configuration. |
| PR Review & Merge Steward | 1.14 | ACTIVE | LOCAL_READY | NOT_CONFIGURED | clean_machine_end_to_end_merge_capstone_pending | commit:ae04404ddb548da8019754561c11a357ae2b794f<br>test:packages/pr/src/__tests__/doctor.test.ts<br>test:packages/pr/src/__tests__/merge.test.ts | Phase 2C chat report and action confirmation active. Supports status/review/recommend/doctor/queue/merge/watch, review/doctor comments, governance audit, operational decision summaries, deadlock detection, Red Zone author-risk preflight, and chat-friendly PR summaries with confirm-merge flow. Repository-event notifications refresh current PR/review/check observations from an explicitly repository-bound live client, but the projection stamps human approval and merge readiness as not evaluated; webhook or live review state never becomes PRMS authority. Workflow artifact governance is bound to deterministic base/head tree evidence and a single current-head human approval carrying Workflow-Trust. |
| Collaboration Layer | 2D/2E | ACTIVE | LOCAL_READY | NOT_CONFIGURED | model_endpoint_not_configured<br>clean_machine_agent_task_capstone_pending | commit:ae04404ddb548da8019754561c11a357ae2b794f<br>test:packages/agent-runtime/src/__tests__/openai-compatible-runtime.test.ts<br>test:packages/collaboration/src/__tests__/conversation-workflow-integration.test.ts | Agent Runtime includes the governed OpenAI-compatible Chat Completions provider and repository tool plane with worktree containment, permission enforcement, budget and response limits, redaction, schema-before-complete, provider-neutral setup/doctor/smoke UX, and preview-first native-keychain credential import. Repository read, search, and diff results now apply context-aware source projections that preserve non-secret code expressions while continuing to redact credential literals and using conservative fallback for configuration, unknown, invalid UTF-8, and binary content before provider reuse or transcript persistence. Full 2D/2E Collaboration Layer active with typed workflow template preview/execute and dashboard with filters (--owner, --module, --risk, --blocker, --type). The GitHub watch delivery router records route-level notification success/failure with stable idempotency evidence, preserves completed routes across retry/restart, and emits fixed live-state/scope diagnostics without storing webhook prose or credentials. Workflow engine with JS module discovery, preview, dry-run, execute, resume, trust levels, and inspect (HTML/JSON/Markdown). Dynamic Workflow Parity v1 active with Operator workflow recommendation/ultracode draft trigger, dynamic workflow draft generation, pattern registry (classify-and-act, fanout-synthesize, adversarial-verification, generate-filter, tournament, loop-until-done, model-router), workflow policy config, run listing/control evidence, save/export-skill, budget/model/isolation metadata, and helper APIs on ctx.workflow. Dynamic Workflow UX Closure active with workflow start aggregation, catalog preview, progress evidence model, TUI workflow home and run drilldown, save-run to project/user/Claude project, and budget/routing visibility across draft/run evidence. Event model, activity feed, digest, handoff, decision, and room views with agent display name resolution. Authz-gated chat cards for handoffs, decisions, tasks, workflows, and plans. Agent registry v1 to v2 migration command. TUI dashboard and room views via --format tui. Workflow artifact PRs use one current-head human Workflow-Trust review, deterministic base/head tree evidence, and one Governance Issue only for new/core artifacts; legacy proposal/review publishers remain available but are not merge gates. Run audit, improvement, split with native sub-issue linking and linear dependency fallback, workflow-aware PRMS blocking, and post-merge governance finalization remain active. Profile Sync Robot active with config-driven check/preview/run, idempotent branch naming, failure issue creation, profile_sync.failed event, watch-daemon auto-pr trigger (manual/watch/auto-pr modes), dedupe queue/worker, TUI profile workbench with 6 actions, PRMS profile-sync governance gate (BLOCKED_PROFILE_SYNC_GATE), and buildProfileSyncStatus finalizer. Agent Conversations active with typed thread model (7 message kinds), JSONL persistence, secret scanning on messages and metadata, agent type resolution with Claude Code subagent compatibility, workbench ask/action audit trail, and conversation commands (start/list/show/send/summarize/archive). Agent Runtime (@openslack/agent-runtime) active with launcher, permission profiles, run store, transcript recording, an instance-scoped provider registry, fail-closed runtime gating, test-only local adapter injection, process bridge diagnostics, Aby external runtime doctor/setup/smoke, worktree isolation, fail-closed metadata validation, MCP descriptor status UX, and redacted bridge stderr summaries. Lifecycle events (started/completed/failed) are wired through executeRun/executeResume via agentEventEmitter bridge into collaboration recordEvent, with activity feed and room integration. TUI AgentRun detail view with bridge/MCP observability timeline and Agent Runtime diagnostics view. Negentropy-Lab slot integration surface is planned as an external scenario-pack.extension contribution; OpenSlack exports workflow, PRMS, profile-sync evidence, and projection data without owning Negentropy-Lab AuthorityState. |

## Components

| Owning Module | Component | Maturity | Declared Operator Baseline | External Blockers | Evidence |
|---------------|-----------|----------|----------|-------------------|----------|
| Collaboration Layer | Agent Runtime | LOCAL_READY | NOT_CONFIGURED | model_endpoint_not_configured<br>live_provider_smoke_pending | commit:ae04404ddb548da8019754561c11a357ae2b794f<br>test:packages/agent-runtime/src/__tests__/openai-compatible-runtime.test.ts |

## Deferred Work

Deferred work is visible but is not a product module and is not counted toward
standalone P0 completion.

| Work | Status | Maturity | Counts Toward Standalone | Branch | Evidence | Notes |
|------|--------|----------|--------------------------|--------|----------|-------|
| Negentropy-Lab Sidecar Integration | DEFERRED | LOCAL_READY | NO | agent/negentropy-sidecar-v1 | commit:3b8f7ba2ebc5665efe6b56db0f76da3bd74f556a<br>repo:docs/status/deferred/negentropy-sidecar.md | Local source evidence is preserved on its deferred branch and excluded from standalone P0 completion. |

## Packages (19 active)

- @openslack/kernel
- @openslack/plugin-api
- @openslack/plugin-host
- @openslack/plugin-testkit
- @openslack/sdk
- @openslack/workspace
- @openslack/runtime
- @openslack/github
- @openslack/core
- @openslack/delivery
- @openslack/cli
- @openslack/operator
- @openslack/chat-gateway
- @openslack/tui
- @openslack/credentials
- @openslack/pr
- @openslack/collaboration
- @openslack/workflows
- @openslack/agent-runtime

## CLI Commands

- openslack self
- openslack workspace
- openslack init
- openslack self plugin run
- openslack self plugin check
- openslack github
- openslack agent
- openslack task
- openslack delivery
- openslack ask
- openslack setup
- openslack status
- openslack doctor
- openslack version
- openslack chat
- openslack pr
- openslack governance
- openslack collaboration activity
- openslack collaboration digest
- openslack collaboration handoff
- openslack collaboration decision
- openslack collaboration room
- openslack collaboration workflow list
- openslack collaboration workflow show
- openslack collaboration workflow validate
- openslack collaboration workflow preview
- openslack collaboration workflow preview-js
- openslack collaboration workflow dry-run
- openslack collaboration workflow run
- openslack collaboration workflow resume
- openslack collaboration workflow trust
- openslack collaboration workflow start
- openslack collaboration workflow generate
- openslack collaboration workflow preview-draft
- openslack collaboration workflow patterns
- openslack collaboration workflow catalog
- openslack collaboration workflow runs
- openslack collaboration workflow config
- openslack collaboration workflow save
- openslack collaboration workflow save-run
- openslack collaboration workflow export-skill
- openslack collaboration workflow publish
- openslack collaboration workflow review-request
- openslack collaboration workflow audit-run
- openslack collaboration workflow split
- openslack collaboration workflow improvement
- openslack collaboration workflow finalize-pr
- openslack collaboration workflow labels
- openslack collaboration inspect
- openslack collaboration workflow profile-sync check
- openslack collaboration workflow profile-sync preview
- openslack collaboration workflow profile-sync run
- openslack collaboration workflow profile-sync status
- openslack conversation start
- openslack conversation list
- openslack conversation show
- openslack conversation send
- openslack conversation summarize
- openslack conversation archive
- openslack agent-runtime doctor
- openslack agent-runtime setup
- openslack agent-runtime credential import
- openslack agent-runtime smoke
- openslack agent-runtime mcp status

## Golden Evals

7/7 passing. Zero stub assertions.

## Test Suite

4201 passing Vitest tests across 327 passing files. No failures recorded.

Module-attributed coverage: 4730 tests across 443 module test files (packages shared across modules are counted per module).

Note: The Vitest line is the raw passing count recorded in .openslack/modules.yaml. The module-attributed coverage line is the per-module sum from .openslack/modules.yaml, where each test file is counted once per module that claims it. Use module counts for coverage tracking; use raw bun run test output for CI verification, including skipped tests.

## Module Registry

Source: `.openslack/modules.yaml` — auto-generated from modules.yaml.
