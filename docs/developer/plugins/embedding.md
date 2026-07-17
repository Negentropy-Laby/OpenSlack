# Plugin Embedding Boundary

OpenSlack 0.2.0 defines a portable public package surface for declarative plugin
contracts, authoring, governed hosting, and conformance testing. It does not make
workspace plugins executable or create a dynamic CLI/TUI extension platform.

## Available now

- `@openslack/plugin-api`: manifest types, strict JSON Schema, authoring validator,
  lifecycle vocabulary, host policy ports, and host-derived activation-evidence types;
- `@openslack/sdk`: type-preserving manifest/descriptor helpers, blockers-only PRMS result
  normalization, and type re-exports;
- `@openslack/plugin-host`: exact-byte manifest and lock loading, Red-local validation,
  instance-scoped registries and lifecycle, host-policy authorization, required audit writes,
  and blockers-only PRMS normalization;
- `@openslack/plugin-testkit`: deterministic G1-G17 authoring diagnostics and
  integrity checks that never substitute for Host authorization;
- `@openslack/operator`: an instance-scoped action-registry port with the existing 30-action
  registry as its compatibility default, plus canonical execution-time `PlanStep`
  revalidation;
- the CLI composition root: one sealed `PluginHost`, Operator action registry, LLM-provider
  registry, and conversation-store binding per application process, with one audited bounded
  GitHub Issues metric target and a fail-closed catalog for every other built-in;
- an internal `self plugin run` proof route that can load locked workspace aliases before seal,
  accepts only composition-injected activation evidence, preserves `SHADOW` as visibility-only,
  and canonicalizes `ENFORCE` plans through the existing Operator registry;
- reviewed bundled descriptor types for code explicitly imported by an application
  composition root.

The four public packages (`plugin-api`, `plugin-host`, `sdk`, and
`plugin-testkit`) have explicit exports, declarations, Node engines, Apache-2.0
metadata, exact-version staged dependencies, and a clean-consumer pack
verification path. Registry publication remains an external release operation.
The proof route is not implicit plugin authority:
the stock composition still denies activation and required audit writes until a trusted embedder
injects policy, durable audit persistence, and matching activation evidence. There is still no
dynamic CLI/TUI registry, directory watcher, npm package scan, or
auto-discovered code execution path in this stage.

## CLI composition root

`createOpenSlackCliContext()` owns the application graph instead of mutating process-global
registries. The top-level `ask` command, nested `operator ask`, TUI workbench, Chat Gateway,
setup report, and doctor report receive the same context instance. Intent resolution, planning,
clarification resume, confirmation, and execution in those entrypoints use its explicit
registries. Constructing a second context creates
independent action, LLM-provider, conversation-store, and host instances. The pre-existing
collaboration workflow loader deliberately retains its compatibility-default registry during P2;
the roadmap explicitly excludes migrating that loader in this stage.

The Operator-to-host adapter is metadata-only. It does not infer disclosure safety from risk or
side-effect metadata: each exposed target requires a complete capability, behavior, and output
contract audit. P2-PR2 exposes only `github.metrics`, which performs the existing bounded ready
GitHub Issues query and emits only the returned item count under the exact `github.issues.read`
capability. Its failure path emits fixed diagnostic prose and returns a failed exit status. A
declarative alias must still request `host.actions.read` to contribute the alias itself.
`status.show` reads GitHub, workspace,
Agent Runtime, and collaboration state; PR reports can contain paths; conversation actions can
contain user content; and evaluation actions can write scorecards. Those actions remain outside
the catalog. The adapter also drops authority-like IDs and fields that the Red host forbids. It
never calls action builders, matchers, or executors. The resulting host is sealed at boot.

P2-PR2 deliberately supplies no implicit plugin authority. Unless an embedding application
injects a `HostPolicyPort` with a durable audit sink, activation, action authorization, and plan
validation deny, while required audit attempts fail closed. Declarative activation and routing
remain explicit composition decisions.

## Declarative proof route

`openslack self plugin run <plugin-id> <action-id>` is nested under the existing `self` command;
it does not add a top-level Commander registry or dynamically register plugin IDs as Operator
actions. Only this run path asks the composition root to load the fixed workspace lock before
sealing its one host instance. Ordinary commands retain the synchronous sealed-host path and do
not scan plugin directories.

The route resolves activation evidence only through a trusted composition callback. There is no
CLI flag for approval, actor identity, evidence JSON, raw input, command, argv, path, URL, or
module code. After host activation and authorization:

- `SHADOW` returns canonical contribution and target identities with `executable: false`; no
  Operator executor is called;
- `ENFORCE` returns a minimal host step, whose scalar input is validated and used to rebuild the
  existing target action through the same instance-scoped `ActionRegistryPort`;
- `executePlan()` revalidates that canonical Operator step again before the audited target runs.

Because this proof command has no interactive confirmation channel, the bridge also rejects any
canonical target that has side effects, requires confirmation, or has a risk level other than
`none`, even if a future host catalog were to expose such a target.

Host authorization and planning form a snapshot for this read-only proof. The host's execution
lease ends when `planAction()` returns, so a later deactivation does not cancel an already planned
`none`-risk Operator step. A strong revocation barrier covering downstream execution would require
a separate Red `plugin-host` contract and is not claimed by this Yellow route.

The proof fixtures live only under CLI tests. The workspace fixture is copied into a temporary
canonical `.openslack/plugins/` layout and locked with the production serializer; no real Red
workspace plugin path is changed by P2-PR3. The reviewed bundled fixture enters only through the
`PluginHost` constructor and targets the same audited `github.metrics` behavior.

## Operator action port

`ActionRegistryPort` is an application-owned execution boundary, not a plugin discovery API.
`planActions()` and `executePlan()` accept an explicit registry instance and otherwise use the
frozen built-in registry. The built-in `RegisteredActionId` union and its 30-action order remain
closed; extension action IDs use `plugin:<plugin-id>:<local-id>` and are isolated to the registry
instance that received them.

At execution, OpenSlack rebuilds each step from its registered definition and input, then
requires an exact match for the action ID, input, tool, command, argv, description,
confirmation flag, and declared outputs. Callbacks receive a frozen canonical copy. Persisted,
LLM-produced, or caller-produced step fields therefore cannot become execution authority merely
by resembling a registered command.

An action `build` or `match` function supplied by a trusted composition root must be
synchronous, deterministic, and side-effect-free. It must not perform I/O or read time/random
state. Whole-plan preflight, per-step authorization boundaries, and post-callback validation may
invoke it more than once. External effects belong only in the canonical execution target after
authorization, never in action-definition construction or matching.

Constructing an action definition remains a trusted composition-root operation. A validated
workspace or installed manifest cannot call `createActionRegistry()`, supply builder functions,
or register raw command/argv. Translating governed declarative aliases into Operator actions is
a later composition-root stage.

## Not an execution API

OpenSlack v1 deliberately does not execute auto-discovered third-party code. A `workspace`
or installed `plugin` provider is a standalone `plugin.json` document with declarative
aliases only. The authoring validator neither reads files nor establishes trust.

The governed Red host implements:

1. bounded exact-byte reads and strict JSON parsing;
2. realpath containment, regular-file checks, and symlink/path-escape rejection;
3. manifest hashing and `.openslack/plugins.lock` comparison;
4. independent non-overridable capability, namespace, contribution-kind, entrypoint, and
   risk-ceiling checks;
5. instance-scoped registration, lifecycle transitions, audit events, and action-time
   authorization.

Audit metadata is limited to host-produced scalar facts. The host must bound and redact every
value before persistence; plugin-returned objects and prose are not audit metadata.

The host receives policy through `HostPolicyPort`; `plugin-api` does not import the kernel,
GitHub clients, credentials, or PRMS implementations. Requested capabilities become
effective only after intersection with host and actor allowlists. Approval and CODEOWNER
evidence remain host-derived current-state facts.

## Product claim

Describe this as a **public declarative embedding contract with a governed
host**. The pack verifier proves ESM imports, declarations, a TypeScript
consumer, and isolated hosts with distinct policy adapters on clean Windows and
Linux consumers. Do not claim executable third-party plugins, sandboxing,
dynamic product-surface registration, or npm availability until the
corresponding external release evidence exists.
