# Changelog

All notable changes to OpenSlack are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-07-19

### Added

- Dual-target Windows x64 and Linux x64 archive construction and verification,
  including SBOMs, checksums, Ed25519-signed provenance envelopes, target identity
  checks, clean-machine smoke coverage, and immutable release-asset guards.
- Four public embedding packages—`@openslack/plugin-api`,
  `@openslack/plugin-host`, `@openslack/sdk`, and
  `@openslack/plugin-testkit`—with Apache-2.0 package metadata, canonical pack
  verification, deterministic staged dependency rewriting, and clean-consumer
  ESM, declaration, TypeScript, and isolated-host checks.
- Protected npm OIDC staged-publishing automation for the four public packages
  after the one-time new-package bootstrap.
- A secret-free live-capstone harness that binds 11 fixed release steps on Windows
  and Linux to one tested commit, redacted evidence references, and a 30-day
  evidence window.
- Preview-first transactional `openslack setup attach` for read-only monitoring
  and full-agent sidecar modes, with workspace locking, durable rollback journals,
  exact post-validation, crash recovery, and idempotent apply.
- Bounded, cached multi-repository PR and check projection with independent
  cursors, a global API budget, repository-scoped refresh, and synthetic-event
  isolation, completed in [PR #206].
- Context-aware Agent Runtime source projection that preserves useful non-secret
  code expressions while conservatively redacting credential literals and
  falling back safely for configuration, binary, unknown, and invalid UTF-8
  content.
- A governed Negentropy-Lab `scenario-pack.extension` preview fixed to external,
  opt-in, L5, SHADOW, and projection-only behavior.

### Changed

- The canonical product registry uses the `modules.v2` model for module and
  component maturity, operator configuration, blocker ownership, evidence, CLI
  groups, packages, and test counts.
- Generated `docs/status/current.md` is the current-state projection of the module
  registry rather than a hand-maintained status claim.
- PRMS Workflow Trust is bound to deterministic base/head tree evidence, the
  synchronized current PR head, and a valid current-head human approval; cached or
  synthetic projection state cannot become approval or merge authority.

### Security

- Agent Runtime fails closed before an allowed provider and credential reference
  are configured and pass readiness checks.
- Credential values are redacted from runtime/provider evidence and are not copied
  into attached repositories, workspace configuration, capstone ledgers, or
  persisted transcripts.
- The instance-scoped Red-Zone plugin host retains strict-byte loading, integrity
  locks, explicit capability and target policy, atomic registries, and required
  audit writes without auto-discovering executable plugin code.
- The live-capstone evidence path includes secret-canary enforcement, bounded
  reference prefixes, and secret-free artifact/hash recording.

### Release gates at branch cut

The following nine unique blocker IDs are external release prerequisites and
evidence gates at this branch cut. They are **not delivered features**, and this
changelog does not assert production readiness. Their final disposition must be
recorded through the [0.2.0 release runbook] and owner-scoped live evidence before
any maturity promotion:

- `signed_v0_2_0_release_pending` — publish and verify both signed target artifact
  sets at the tested commit.
- `clean_machine_release_capstone_pending` — pass release-artifact and extracted
  archive verification on Windows and Linux.
- `npm_publication_pending` — bootstrap, publish, and independently verify all
  four `0.2.0` packages, then restrict trusted publishers to staged publishing.
- `clean_machine_bot_delivery_smoke_pending` — complete live issue claim and
  bot-authored PR delivery with GitHub evidence.
- `model_endpoint_not_configured` — configure the provider through a credential
  reference and prove ready doctor and provider-smoke results for every owning
  module/component.
- `clean_machine_onboarding_smoke_pending` — pass transactional guided attach on
  both clean-machine platforms.
- `clean_machine_end_to_end_merge_capstone_pending` — pass the current-head PRMS,
  authorized non-author human approval, governed merge, and Issue completion
  sequence.
- `clean_machine_agent_task_capstone_pending` — pass the complete live agent-task
  delivery and governed completion flow.
- `live_provider_smoke_pending` — pass the OpenAI-compatible provider smoke on
  Windows and Linux for each owning module/component.

### Out of scope

- GitHub Enterprise Server support.
- Automatic CLI update or rollback.
- Negentropy-Lab registration, activation, authority ownership, or ENFORCE-mode
  integration.
- A public Sidecar SDK.

[Unreleased]: https://github.com/Negentropy-Laby/OpenSlack/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Negentropy-Laby/OpenSlack/releases/tag/v0.2.0
[PR #206]: https://github.com/Negentropy-Laby/OpenSlack/pull/206
[0.2.0 release runbook]: docs/developer/release-0.2.0.md
