/** An isolated, keyless profile for actual SDK/Loader/peer compatibility tests. Not a runtime export. */
import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { publicAliases } from '../../runtime-public.mjs'
import { RUNTIME_PEERS } from '../../src/runtime-bindings.ts'

/** Create fixture inputs only; dependencies and lib outputs must already have been built by the owning workspace. */
export function prepareSdkFixture(root: string, script: Array<string | { name: string; args: object; poll?: boolean }>, installSpec?: string) {
  const repository = process.env.DEEPSEEK_HARNESS_CHECKOUT
  if (!repository) throw new Error('An unmodified built Harness dependency is required')
  const pluginRoot = fileURLToPath(new URL('../../', import.meta.url))
  const aliases = publicAliases(repository)
  const runtimeEntries = Object.fromEntries(RUNTIME_PEERS.map(name => [name, aliases[name]]))
  const home = join(root, 'home')
  const profile = join(home, 'profiles/sdk')
  const workspace = join(root, 'workspace')
  mkdirSync(profile, { recursive: true })
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'fixture.txt'), 'before')
  writeFileSync(join(root, 'script.json'), JSON.stringify(script))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'openslack-keyless-fixture', private: true,
    dependencies: {}, dsh: { profile: { bundles: [] } } }))
  const plugin = (path: string, id: string, config?: object) => {
    const manifestPath = join(repository, path, 'package.json')
    const metadata = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string }
    return { id, name: pathToFileURL(createRequire(manifestPath).resolve(metadata.name)).href, ...(config ? { config } : {}) }
  }
  // A packed plugin does not make this source checkout a linked package root.
  // Place the test-only model in the fixture profile's own public resolution
  // scope, not inside or as a patch to the installed package.
  let scriptedModel = join(pluginRoot, '.build/fixtures/scripted-model.js')
  if (installSpec) {
    const installedFixture = join(profile, 'scripted-model.js')
    copyFileSync(scriptedModel, installedFixture)
    scriptedModel = installedFixture
  }
  const rows = [
    plugin('packages/llm/llm', 'llm'),
    plugin('packages/core/session', 'session'),
    plugin('packages/session/session-projection', 'session-projection'),
    plugin('packages/core/system-prompt', 'system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false }),
    plugin('packages/core/tools', 'tools'),
    plugin('packages/core/tool-executor-native', 'tool-executor-native'),
    { ...plugin('packages/core/tool-executor-ptc', 'tool-executor-ptc'), disabled: true },
    plugin('packages/fs/fs-local', 'fs'),
    plugin('packages/session/working-directory', 'working-directory'),
    plugin('packages/fs/fs-observation-policy', 'fs-policy'),
    plugin('packages/fs/tool-fs', 'tool-fs'),
    plugin('packages/core/agent', 'agents'),
    plugin('packages/core/agent-loop', 'agent-loop', { agents: [] }),
    plugin('packages/session/session-persistence-jsonl', 'sessions', { root: join(root, 'logs'), compression: 'none' }),
    { id: 'fixture-model', name: pathToFileURL(scriptedModel).href,
      config: { script: join(root, 'script.json'), requests: join(root, 'requests.jsonl') } },
    plugin('packages/sdk/server', 'sdk-jsonrpc-server', { maxTokensAsSuccess: false }),
  ]
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
  execFileSync(process.execPath, [join(repository, 'apps/cli/lib/bin.js'), 'plugin', '--profile', 'sdk', 'add',
    installSpec ?? `link:${pluginRoot}`, '--offline', '--ignore-scripts'], { cwd: workspace,
    env: { PATH: process.env.PATH, DSH_HOME: home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    stdio: 'pipe', timeout: 60_000 })
  const patch = join(root, 'worker.patch.json')
  writeFileSync(patch, '[]')
  const binding = join(root, 'binding.json')
  writeFileSync(binding, JSON.stringify({ taskId: 'TASK-1', runId: 'RUN-TEST', principalId: 'synthetic-fixture-only',
    generation: 'fixture-g1', root: workspace, expiresAt: new Date(Date.now() + 120_000).toISOString(),
    readPaths: ['fixture.txt'], writePaths: ['fixture.txt'], systemText: '', callbacks: false, resultMode: 'text', runtimeEntries }), { mode: 0o600 })
  const installedRoot = realpathSync(join(profile, 'node_modules/@openslack/deepseek-harness-plugin'))
  return { repository, pluginRoot: installedRoot, home, workspace, patch, binding, runtimeEntries: JSON.stringify(runtimeEntries) }
}
