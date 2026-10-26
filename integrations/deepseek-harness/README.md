# OpenSlack external plugin for DeepSeek Harness

`@openslack/deepseek-harness-plugin` belongs to OpenSlack. It runs against an
**unmodified** Harness checkout at
`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`, SDK/dsh `0.2.1-rc.3`, and Node
`24.18.1`. It neither installs a Harness application bin nor patches its SDK,
MCP implementation, lockfile, source, or default profile.

## Build and install

First install the pinned Harness's locked dependencies and build its original
artifacts. Do not copy dependencies, `lib`, credentials, identities, or patched
outputs from an experimental checkout. From the OpenSlack repository root:

```sh
export DEEPSEEK_HARNESS_CHECKOUT=/absolute/path/to/unmodified-built-harness
bun run build
bun integrations/deepseek-harness/build.mjs
bunx vitest run integrations/deepseek-harness
```

The plugin has an independent public-declaration typecheck. Runtime peers remain
external to its bundles and are supplied by the approved Harness installation;
there must not be a second Cordis, Tools, FS, or SDK runtime instance. Missing or
unqualified deployment dependencies fail closed. The test configuration requires
the same explicit built dependency; it never silently substitutes a fixture SDK.

To create a local archive (not a registry publication):

```sh
cd integrations/deepseek-harness
npm pack --ignore-scripts --pack-destination /absolute/path/to/output
```

An administrator can subsequently install that archive through the original
Harness plugin manager, into an **existing approved** SDK home:

```sh
DSH_HOME=/approved/home dsh plugin --profile sdk add /absolute/path/to/plugin.tgz --offline --ignore-scripts
```

Installation contributes a **disabled** `openslack-readonly` row. It does not
enable tools, provision identities, configure credentials, approve tasks, or
change the default profile. A deployment-owned per-launch patch must explicitly
enable and configure it. Native Windows uses its own native paths and approved
home, not WSL paths. Production credentials stay in the existing Harness service.

## Entrypoints and trust boundary

| Export | Purpose |
| --- | --- |
| Package root | Worker: exact native file scope, current-task report, current-run query |
| `/initiator` | Dispatch one existing approved task and query its returned run |
| `/readonly` | Original twelve read-only OpenSlack MCP tools |
| `/sdk-host` | Public SDK server plus private live authorization and shutdown coordination |

`dist/startup.js` is a private Bridge peer artifact, not a model tool or a new
application bin. OpenSlack fixes Harness/plugin roots and build identities, Node
executable/version/hash, approved home, model route, verification, and task scope.
Models cannot supply any of them. The only allowed mounts are the separately
bound exact public Harness export files and exact external plugin artifacts;
there is no directory-wide external-code allowance. The compiled scripted model
under `.build/fixtures` is test-only and excluded from archives.

SDK-host and read-only configuration also contain `runtimeEntries`, the serialized
exact public ESM map produced by the host's `harnessPublicRuntimeEntries()`.
The host rejects physical peer overrides before launch; the SDK host checks its
actual public resolver against that bound map before creating its server/MCP.
The SDK client runs outside dsh and is independently resolved at its approved
package anchor, not installed again into the plugin's runtime.

The SDK launch overlay disables the original `sdk-jsonrpc-server` row and mounts
`/sdk-host` instead. There is exactly one STDIO server; standard requests are
delegated to the public `HarnessSdkJsonRpcServer` and `JsonRpcLineTransport`.
No private SDK fields or monkey patches are used. The peer observes the actual
SDK-spawned child through Node's public, experimental `child_process` diagnostics
channel. The deployment pin is intentional; unavailable observation is not a
reason to accept an unobserved exit.

The external native MCP owner keeps raw write definitions private. Only scoped
wrappers are visible to the model. Confirmation bearers remain in a process-local
vault, never Session/transcript/evidence; local confirm/cancel accept only plan ID.
Worker callbacks cannot dispatch recursively. Live host authorization runs before
file effects, and the existing FS observation/version guard remains in force.
MCP disconnect invalidates capabilities without automatic reconnect or replay.

## Completion and recovery

Dispatch confirms durable **pending admission**, not task completion. The host
performs exclusive idempotent admission; same-key input drift is rejected and
uncertain admission is not replayed. Progress reports cannot declare acceptance.

Success requires all of: completed Session and owned work, generation-bound
prepare-shutdown, confirmed MCP stop, standard shutdown ACK, directly observed
SDK close with code zero/no signal/no requested termination, peer exit, then
host-owned acceptance of baseline, scope, output, bytes and evidence. Sending a
signal, `prompt()`, idle, ACK, or exit zero alone is insufficient. Failed startup,
forced termination, failed disposal, missing observation or unknown side effects
cannot produce verified completion.

The original caller reads the same run through the unchanged
`openslack_get_activity({objectKind: 'workflow', objectId: runId})` tool. Recovery
is read-only reconciliation: no new prompt, automatic Session resume, replacement
Session, or redispatch. Preserve retained worktrees and run evidence.

Keyless scripted-model compatibility tests are separate from real principal/model
qualification, native Windows, hosted CI, and human acceptance. None is implied
by installation or green local tests. Real deployment parameters are supplied
after implementation. No approval, merge, release, identity bootstrap, or changes
to #415/#425 are part of this plugin delivery.

## Attribution

The scope/peer implementation was migrated from the preserved integration
experiment. The icon and MIT license originate from DeepSeek Harness; runtime
Harness code is reused through its public packages, not copied into this plugin.
See [LICENSE](./LICENSE) and the [OpenSlack architecture guide](../../docs/architecture/components/agent-runtime.md).
