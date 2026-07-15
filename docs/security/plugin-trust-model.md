# Plugin Trust Model

This document defines the normative trust boundary for the OpenSlack plugin system. The private
Red host and integrity loader implement the v1 declarative discovery, registration, and activation
boundary; public embedding and executable third-party plugins remain future work. The claims below
are security invariants, while implementation evidence lives in `packages/plugin-host` and its
adversarial tests.

The central rule is that auto-discovered third-party plugins are declarative only. A workspace or installed manifest cannot supply executable code, widen policy, create approval authority, or bypass the independently enforced rules of the Red host.

## A1 — Separate Internal Plugins from the Negentropy Adapter

`openslack.plugin.v1` is an OpenSlack-owned contract. It does not contain Negentropy-specific `slotId`, `layer`, `skuKey`, `authorityWriterHandle`, or `proposeMutation` fields.

The Negentropy-Lab integration is a separate adapter:

```text
OpenSlack evidence model -> Negentropy SlotContribution
```

That adapter validates against a pinned upstream schema. It never becomes OpenSlack's internal plugin loader, and `PluginHost` never imports a Negentropy external contribution. See [Negentropy-Lab Slot Boundary](negentropy-slot-boundary.md) for the external authority boundary.

## A2 — Trust Tiers Are Execution Rules

Provider labels are not descriptive metadata alone. They determine discovery, execution, and activation rules.

| Provider kind       | Discovery                                              | Code execution in v1                     | Activation                      |
| ------------------- | ------------------------------------------------------ | ---------------------------------------- | ------------------------------- |
| `built-in`          | Compiled into OpenSlack                                | In-process                               | Host boot                       |
| `bundled`           | Explicitly imported by an application composition root | In-process; trusted by repository review | Host policy evidence            |
| `workspace`         | `plugin.json` under the workspace                      | **None; declarative only**               | Integrity lock plus host policy |
| `plugin`            | Installed manifest or package metadata                 | **None; declarative only**               | Integrity lock plus host policy |
| Negentropy external | Separate export adapter                                | Never imported by `PluginHost`           | Negentropy-owned                |

No provider label, gate mode, or manifest field can turn a declarative descriptor into executable code. A future executable third-party runtime requires a separate ADR, threat model, cross-platform containment prototype, adversarial tests, and Red approval. It is outside this v1 contract.

Trusted bundled code runs in-process because it was explicitly imported and reviewed. Reviewed
definitions and their evidence enter only through constructor-owned composition data; the public
host has no late bundled-registration or rebind method. This trust decision is not a sandbox claim.

## A3 — Strict JSON Manifest, No Source-Code Extraction

Auto-discovered plugins use a standalone UTF-8 `plugin.json`. The loader must:

1. resolve the candidate with `realpath`;
2. reject symlinks and path escapes;
3. read through a bounded file operation with a size limit;
4. parse strict JSON;
5. validate a versioned schema;
6. hash the exact validated UTF-8 bytes read from that file handle;
7. compare the hash with `.openslack/plugins.lock`; and
8. register only declarative contributions.

The manifest format forbids a byte-order mark, duplicate keys, non-JSON values, and unknown security-sensitive fields. The implementation must parse and hash one bounded byte buffer; it must not validate one read and register a later read. Containment and regular-file checks are repeated around the open/read operation. Whitespace changes therefore require an intentional lock refresh instead of relying on an underspecified canonicalization algorithm.

For `workspace` and `plugin` providers, the loader must not use `import()`, `require()`, `eval`, TypeScript parsing, regex-based implementation detection, or fallback execution. The existing workflow loader remains unchanged and is not a plugin security primitive.

`@openslack/plugin-api` schemas and validation results provide authoring feedback only. They are not authorization. The Red `@openslack/plugin-host` boundary must independently enforce every non-overridable capability, contribution-kind, executable-entrypoint, namespace, and risk-ceiling rule before registration. Broadening a Yellow public contract must remain harmless until the Red host explicitly accepts the new behavior.

## A4 — Host Policy Is Injected, Not Imported from the Public API

`@openslack/plugin-api` has zero runtime dependencies and defines portable types. `@openslack/plugin-host` receives a `HostPolicyPort` with these responsibilities:

- `authorizeActivation`;
- `authorizeAction`;
- `validatePlanStep`; and
- `recordAuditEvent`.

The CLI composition root adapts `@openslack/kernel` and PRMS to this port. This keeps the public API independent, avoids publishing the kernel merely to close a dependency graph, and permits an embeddable host without duplicating policy truth.

The port returns typed decisions. It does not expose GitHub clients, approval fetchers, credential stores, or mutable policy objects to plugins. Fetching current GitHub state and applying `filterValidApprovals` remain application and PRMS responsibilities before the host receives `ActivationEvidence`.

## A5 — Authorization Is Host-Owned

A manifest may request capabilities; it cannot grant them. The effective capability set is:

```text
requested ∩ hostAllowed ∩ actorAllowed
```

The host enforces non-overridable denials for:

- submitting or relaying an approval review as an agent;
- pushing directly to `main`;
- reading or exposing secrets or credentials;
- editing constitutional rules or an agent's own prompt or registry;
- satisfying human-approval or CODEOWNER requirements; and
- mutating Negentropy `AuthorityState`.

For trusted bundled code, these are policy checks rather than process isolation. The code is trusted only because the application explicitly imported it and repository governance reviewed it.

## A6 — Approval Is Host-Owned; Only Trusted Code May Append PRMS Blockers

Trusted, explicitly imported bundled PRMS extensions may return only additional blockers:

```text
evaluate(report) -> { blockers: BlockingFinding[] }
```

They cannot return `PASS`, authority-bearing blocker codes, approval counts, mergeability, or an
authorization decision. Each evaluator receives a fresh, deeply frozen, bounded plain-data
projection rather than the caller's PRMS report, so one evaluator cannot mutate another
evaluator's view. Projection, evaluation, timeout, and result-validation failures become
host-generated blockers. The host computes approval from current GitHub review state using
`filterValidApprovals` and combines extension blockers using logical-AND, fail-closed semantics.

Auto-discovered `workspace` and `plugin` manifests cannot contribute an evaluator, predicate DSL, approval source, or PRMS gate implementation in v1. They may only declare that activation is subject to a named, host-owned gate.

Review webhooks are informational projections. They may trigger a fresh PR fetch, but the payload itself never becomes approval authority.

## A7 — Built-In Namespaces Remain Closed

`RegisteredActionId` remains the closed namespace for built-in actions. Plugin-contributed aliases use a separate namespaced identifier:

```text
plugin:<plugin-id>:<action-id>
```

A declarative action may reference only an existing, side-effect-free host action with a bounded input mapping. A mapping may contain validated constants and pass-through fields already present in the target action schema. It cannot provide raw `command`, arbitrary argv, shell or template strings, file/module/URL paths, risk metadata, or `confirmationRequired`.

Trusted bundled actions may provide functions, but each declares a fixed host action target that is
resolved from the constructor-owned catalog. The host authorizes that sealed target before invoking
the builder, requires its effective capability, and rejects any emitted `PlanStep` that changes the
target. Every resulting step is then revalidated against current host policy.

`SHADOW` mode never invokes bundled activation/deactivation hooks, action builders, or PRMS
evaluators. In `ENFORCE`, host-owned deadlines bound asynchronous hooks, builders, and evaluators;
timeout is a denial/failure, not permission to retry after possible side effects. These deadlines do
not provide process isolation or preempt synchronous non-yielding code.

| Contribution                                                 |      `built-in` or reviewed `bundled` | `workspace` or installed manifest |
| ------------------------------------------------------------ | ------------------------------------: | --------------------------------: |
| New action implementation                                    |     Allowed through a typed host port |                         Forbidden |
| Alias of a host read-only action                             |                               Allowed |                           Allowed |
| Alias of a mutating or high-risk action                      |                      Host policy only |                   Forbidden in v1 |
| Workflow implementation, path, or URL                        | Explicit composition-root import only |                         Forbidden |
| Alias of a pre-registered side-effect-free host catalog item |                               Allowed |                           Allowed |
| PRMS blocker evaluator                                       |              Append-only blocker port |                         Forbidden |
| Approval, identity, risk-zone, or CODEOWNERS contribution    |                             Forbidden |                         Forbidden |

This matrix is normative. Mislabeling a provider kind or gate mode cannot make a descriptor executable or grant it mutation authority.

## A8 — The Integrity Lock Is Not Approval Evidence

`.openslack/plugins.lock` records canonical identity and integrity only:

- schema version;
- plugin ID and version;
- provider kind and source;
- manifest SHA-256;
- optional package digest; and
- requested gate mode, never the effective activation decision.

The lock answers which bytes were reviewed or selected; it does not answer whether those bytes are authorized to activate now. Fields such as `approvedBy` and `approvedAt` are not trusted authorization evidence because any PR author could type them.

`authorizeActivation` receives separate, host-derived `ActivationEvidence`. In the OpenSlack repository, plugin lock and configuration changes are Red and can reach `main` only through the governed PR path. Integrity verification is necessary, but it is never approval and never substitutes for current host policy evidence.

## A9 — Lifecycle Names May Align; Ownership May Not

Internal declarative plugins use this host-owned lifecycle:

```text
discovered -> integrity_verified -> validated -> registered -> activated
```

`degraded`, `disabled`, `deprecated`, and `removed` are explicit transitions. `installed` is optional source-acquisition metadata for a package and is never a shortcut around integrity verification or validation.

This lifecycle belongs to the OpenSlack host. The separate Negentropy adapter reports the external contribution's Negentropy lifecycle from Negentropy-owned evidence and never claims that OpenSlack can register, activate, or mutate that external slot.
