# OpenSlack external plugin for DeepSeek Harness

`@openslack/deepseek-harness-plugin` belongs to OpenSlack. It runs against an
**unmodified** Harness checkout at
`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`, SDK/dsh `0.2.1-rc.3`, and Node
`24.18.1`. It neither installs a Harness application bin nor patches its SDK,
MCP implementation, lockfile, source, or default profile.

## Build and install

First install the pinned Harness's locked dependencies and build its original
artifacts. Do not copy dependencies, `lib`, credentials, identities, or patched
outputs from an experimental checkout. Building the private Windows x64
supervisor also requires Go `1.26.5`; the build fixes `GOWORK=off` and does not
use the repository's worker/Broker modules. Go is not a plugin runtime dependency.
From the OpenSlack repository root:

```sh
export DEEPSEEK_HARNESS_CHECKOUT=/absolute/path/to/unmodified-built-harness
bun integrations/deepseek-harness/prepare-compatibility.mjs
bunx vitest run --config integrations/deepseek-harness/vitest.config.ts
```

The plugin has an independent public-declaration typecheck. Runtime peers remain
external to its bundles and are supplied by the approved Harness installation;
there must not be a second Cordis, Tools, FS, or SDK runtime instance. Missing or
unqualified deployment dependencies fail closed. The test configuration requires
the same explicit built dependency; it never silently substitutes a fixture SDK.
The explicit preparation forces TypeScript emission, stages the existing exact
schema assets and fixed runner bundle, builds the plugin and records
an ignored content witness for source/config/locks, public dependency artifacts,
tools and outputs. Test configuration only verifies it; it never builds or skips.
After source, output, compiler or dependency drift, rerun that preparation command.
Preserved mtimes do not bypass verification. The witness is not deployment authority.
This prepares ignored artifacts only; it never runs the sealed worker or changes
its source, contracts or deployment eligibility. Formal preparation rejects the
fixture-only wire/staging-root overrides.

Ordinary root tests build OpenSlack first and do not require a Harness checkout.
With the explicit checkout they also include this compatibility project. CI sets
`OPENSLACK_HARNESS_COMPATIBILITY=required`; CI and complete inventory collection
fail on a missing checkout rather than silently dropping this project's cases.
The two CI workflows call `scripts/ci/prepare-harness-deps.sh`. Their delimited
OS/commit/lock/tool-version primary cache key selects only the pnpm download store,
with side-effect caching disabled and integrity verification retained. Cache hits
never skip frozen installation or either original build check; identity, home,
node_modules and lib/dist outputs are not cached.
GitHub may return a primary-key prefix match even without restore keys; a cache
match is not artifact, execution or deployment evidence.

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

The approved configured dispatcher is explicitly selected with
`mcp serve --stdio --profile agent-bound --principal-ref <approved-agent> --harness-task-host`.
Ordinary agent-bound serving does not inspect another principal's Harness
deployment. A worker instead uses its host-authored `--harness-worker-binding`;
worker/dispatcher/injected-host combinations are rejected, not silently ignored.

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

Deployment byte proofs also bind the installed package dependency closure, not
only public entrypoints or lock versions: nested chunks, transitive copies,
native code and resources remain included. `openslack.installed_runtime_closure.v2`
frames normalized relative paths, exact byte lengths and stable-descriptor SHA-256
values; large resources stream within 256 MiB/file, 512 MiB total, 1,024 packages
and 32,768 files. Protected configuration/key material is metadata-rejected.
The plugin uses the shared framed `openslack.harness_plugin_artifacts.v2` digest.
These are byte proofs, not extra mounts or permissions. Existing deployment
approvals/receipts are not rewritten or silently accepted under the new domains.

The SDK launch overlay disables the original `sdk-jsonrpc-server` row and mounts
`/sdk-host` instead. There is exactly one STDIO server; standard requests are
delegated to the public `HarnessSdkJsonRpcServer` and `JsonRpcLineTransport`.
No private SDK fields or monkey patches are used. The peer observes the actual
SDK-spawned child through Node's public, experimental `child_process` diagnostics
channel. The deployment pin is intentional; unavailable observation is not a
reason to accept an unobserved exit.

The host carries a run/generation-bound, non-authorizing start restriction through
the private peer arguments and SDK overlay. It is checked after expensive
observations, dependency loading and SDK initialization, and before the first
prompt. Missing data is not an unlimited lease. Expiry never disables owned
prepare-shutdown, cancellation or cleanup.
The public `llm/stream` boundary also checks when the lazy stream is first
iterated, after framework preparation awaits; this is not a claim of atomicity
inside a private provider's later HTTP implementation.

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

On Windows x64 the private bundled supervisor assigns the peer to a nonbreakaway
Job at suspended process creation, before any code executes. A clean receipt
requires the root to stop, the Job to become empty and both output pipes to drain,
followed by actual helper exit. Unknown or forced cleanup is never success; an
unsupported supervisor cannot fall back to direct Node termination. The total
task budget reserves 30 seconds for cleanup, including a shared 24-second SDK
shutdown cutoff; heartbeat cannot extend either deadline.

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
The bundled Go executable's redistribution notices are in
[THIRD-PARTY-NOTICES.txt](./THIRD-PARTY-NOTICES.txt).
