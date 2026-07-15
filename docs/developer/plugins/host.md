# Governed Plugin Host Preview

`@openslack/plugin-host` is OpenSlack's private Red trust boundary for declarative plugins and
explicitly imported reviewed bundles. It is instance-scoped and has no global registry, reset, or
`force` escape.

## Trust path

Workspace manifests are selected only through canonical entries in the fixed
`<workspaceRoot>/.openslack/plugins.lock` and read from
`<workspaceRoot>/.openslack/plugins/<id>/plugin.json`. Installed manifests require an explicit
absolute installed root and a canonical logical `sourceRef`. The host does not use a configurable
workspace state directory for these files because `.openslack/plugins/**` and
`.openslack/plugins.lock` are the Red paths protected by repository governance.

The loader performs this fail-closed sequence:

```text
fixed source entrypoint
  -> lstat/realpath containment and no-link checks
  -> O_NOFOLLOW open where supported
  -> fstat and bounded fd read
  -> second fstat/lstat/realpath identity check
  -> fatal UTF-8 and strict duplicate-aware JSON parse
  -> Red-local hard-denial and manifest validation
  -> SHA-256 of that same bounded Buffer
  -> exact lock identity/source/gate/hash comparison
  -> target/capability/collision preflight
  -> atomic registry commit
```

The lock serializer owns a deterministic v1 byte format: closed identity/integrity fields,
ASCII code-unit tuple ordering, two-space JSON indentation, LF line endings, and one trailing LF.
It never records approvers, actors, effective capabilities, or activation decisions. Lock updates
are explicit; mismatch is never self-healed.

## Host lifecycle

A composition root constructs a `PluginHost` with its OpenSlack version, composition ID, gate IDs,
host-owned action/workflow target facts, and any explicitly reviewed bundled definitions. There is
no public rebind or late bundled-registration method. The host may load declarative candidates and
then seals registration before execution. A different binding requires a different host instance.

```ts
const host = new PluginHost({
  policy,
  binding: {
    compositionId: 'openslack.desktop',
    openslackVersion: '0.1.1',
    gateIds: ['host.read-only'],
    targets: { actions: readOnlyActionFacts, workflows: readOnlyWorkflowFacts },
  },
  bundledPlugins: reviewedBundles.map(({ definition, evidence }) => ({ definition, evidence })),
  operationTimeoutMs: 5_000,
});

await host.loadWorkspacePlugins({ workspaceRoot });
host.seal();
await host.activate('repository-observer', activationEvidence);
```

Workspace and installed loads re-check the sealed state immediately before their synchronous
registry commit, so an in-flight read cannot register after `seal()`. Lifecycle operations and
action/PRMS execution are also mutually exclusive per plugin; concurrent activation,
deactivation, or execution cannot invoke a reviewed hook twice or cross a deactivation window.

Activation evidence is rebuilt from enumerable data properties and matched against the internal
load record. `integrityMatched: true` or `humanApproval.satisfied: true` alone grants nothing.
Effective capabilities are the requested/host/actor intersection, further narrowed by the Red
hard allowlist and contribution requirements. Required activation/action audit persistence occurs
before an allow transition or routed plan is exposed.

## Contribution boundary

- Declarative manifests can register only aliases to host catalog entries proven side-effect-free,
  risk `none`, confirmation-free, and unable to expose secrets, credentials, or paths.
- Alias scalar mappings are checked against both declared inputs and the target schema.
- Reviewed bundled definitions enter only through constructor-owned composition data; a provider
  string, TypeScript cast, or later method call cannot elevate a manifest into executable code.
- Every action target declares a required capability. A bundled action declares one fixed target,
  which the constructor resolves against its normalized catalog. Action authorization happens
  before the builder, and builder output must retain that same target.
- Bundled PRMS evaluators receive separate deeply frozen data projections and can append blockers
  only. Getters, symbols, custom prototypes, authority-bearing blocker codes, malformed output,
  projection failures, evaluator failures, and timeouts fail closed.
- `SHADOW` contributions are inert previews: hooks, action builders, and PRMS evaluators are never
  invoked.

## Non-claims

This preview does not scan `node_modules`, import manifest entrypoints, execute workspace or
installed JavaScript, install dependencies, register CLI/Operator/TUI extensions, or provide a
sandbox. Reviewed bundled code runs in-process because the application imported it explicitly;
that is a repository-governance trust decision, not isolation. Host-owned async deadlines bound
settlement time but cannot preempt a synchronous infinite loop in the shared process.
