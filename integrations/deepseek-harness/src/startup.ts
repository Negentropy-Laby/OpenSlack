/** Private STDIO Bridge peer; Harness applications still start through dsh --profile sdk. @module */
import { constants, fstatSync, openSync, closeSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { loadPublicHarness } from './runtime.ts'
import { createOwnedSdk } from './owned-sdk.ts'
import { OpenSlackPeer, parseFrame } from './bridge.ts'
import type { Config } from './index.ts'

interface WorkerBinding extends Config {
  resultMode: 'text' | 'json'
  runtimeEntries: Record<string, string>
  callbackMcp?: { cliModule: string; workspaceRoot: string; principalRef: string }
}

function options(args: string[]): Map<string, string> {
  const map = new Map<string, string>()
  const accepted = ['--harness-root', '--home', '--agent', '--provider', '--model', '--patch', '--binding', '--timeout-ms']
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key || !accepted.includes(key) || !value || map.has(key)) throw new Error('Invalid peer deployment arguments')
    map.set(key, value)
  }
  if (accepted.some(key => !map.has(key))) throw new Error('Incomplete peer deployment arguments')
  for (const key of ['--harness-root', '--home', '--patch', '--binding']) {
    if (!isAbsolute(required(map, key))) throw new Error('Peer deployment requires absolute native paths')
  }
  return map
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key)
  if (!value) throw new Error('Incomplete peer deployment arguments')
  return value
}

function readBinding(path: string): WorkerBinding {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(file)
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('Invalid task binding file')
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('resultMode' in value) ||
      (value.resultMode !== 'text' && value.resultMode !== 'json')) throw new Error('Invalid task output binding')
    // The same Loader Config schema validates this durable deployment input before Agent creation.
    return value as WorkerBinding
  } finally { closeSync(file) }
}

/** Own stdin, one task SDK, the per-launch patch, and shutdown through confirmed SDK exit. */
async function main(): Promise<void> {
  const deployment = options(process.argv.slice(2))
  const runtime = await loadPublicHarness(required(deployment, '--harness-root'))
  const binding = readBinding(required(deployment, '--binding'))
  const { resultMode, callbackMcp, runtimeEntries, ...scopeBinding } = binding
  if (binding.callbacks && (!callbackMcp || !isAbsolute(callbackMcp.cliModule) || !isAbsolute(callbackMcp.workspaceRoot) ||
    !callbackMcp.principalRef || !callbackMcp.cliModule.endsWith('.js'))) throw new Error('Missing trusted task callback MCP deployment')
  const timeout = Number(deployment.get('--timeout-ms'))
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('Invalid peer deadline')
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let patchDirectory: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const peer = new OpenSlackPeer({
    validateEvent: runtime.sdk.validatedSessionEvent, expandStream: runtime.llm.expandAssistantStream,
    runId: binding.runId,
    resultMode,
    agentId: required(deployment, '--agent'), model: required(deployment, '--model'), root: binding.root,
    allowedTools: ['Read', 'Write', 'Edit',
      ...(binding.callbacks ? ['mcp.openslack.openslack_get_activity', 'mcp.openslack.openslack_preview_workflow',
        'mcp.openslack.openslack_confirm_plan', 'mcp.openslack.openslack_cancel_plan'] : [])],
    createSdk(systemText, allowedTools, authorize) {
      patchDirectory = mkdtempSync(join(tmpdir(), 'openslack-sdk-'))
      const patch = join(patchDirectory, 'scope.patch.json')
      const config: Config = {
        ...scopeBinding, systemText: [binding.systemText, systemText].filter(Boolean).join('\n\n'),
        readPaths: allowedTools.includes('Read') ? binding.readPaths : [],
        writePaths: allowedTools.includes('Write') && allowedTools.includes('Edit') ? binding.writePaths : [],
        callbacks: binding.callbacks && ['mcp.openslack.openslack_get_activity', 'mcp.openslack.openslack_preview_workflow',
          'mcp.openslack.openslack_confirm_plan', 'mcp.openslack.openslack_cancel_plan'].every(name => allowedTools.includes(name)),
      }
      const mcp = callbackMcp && config.callbacks ? { mode: 'task' as const,
        workspaceRoot: callbackMcp.workspaceRoot, cliModule: callbackMcp.cliModule,
        principalRef: callbackMcp.principalRef, workerBinding: required(deployment, '--binding'), timeoutMs: timeout } : undefined
      writeFileSync(patch, JSON.stringify([
        { id: 'tool-executor-ptc', disabled: true },
        { id: 'tool-executor-native', disabled: false },
        { id: 'sdk-jsonrpc-server', disabled: true },
        { insert: [{ id: 'openslack-sdk-host', name: new URL('./sdk-host.js', import.meta.url).href,
          config: { generation: binding.generation, runtimeEntries: JSON.stringify(runtimeEntries), ...(mcp ? { mcp } : {}) } }] },
        { insert: [{ id: 'openslack-task-scope', name: new URL('./index.js', import.meta.url).href, config }] },
      ]), { flag: 'wx', mode: 0o600 })
      const patches = [required(deployment, '--patch'), patch]
      return Promise.resolve(createOwnedSdk({
        runtime, generation: binding.generation, requireMcp: !!mcp,
        launch: {
          dshBin: runtime.dshBin, dshHome: required(deployment, '--home'), profile: 'sdk', patches,
          processCwd: binding.root, cwd: binding.root,
          provider: required(deployment, '--provider'), model: required(deployment, '--model'),
          initializeTimeoutMs: timeout, requestTimeoutMs: timeout,
        },
        async authorize(method, params) {
          if (method !== 'openslack/tool-authorize' || params.runId !== binding.runId ||
            params.taskId !== binding.taskId || params.principalId !== binding.principalId ||
            typeof params.toolName !== 'string') throw new Error('Unrelated SDK host request')
          await authorize(params.toolName, params.input)
          return { allowed: true }
        },
      }))
    },
  }, (frame) => { process.stdout.write(`${JSON.stringify(frame)}\n`) })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    if (timer) clearTimeout(timer)
    input.close()
    process.stdin.pause()
    await peer.close()
    // The generated launch patch is retained with the execution evidence.
  })()
  const stop = (): void => { void close().catch(() => { process.exitCode = 1 }) }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  input.once('close', stop)
  input.on('line', (line) => {
    try {
      const frame = parseFrame(line)
      if (!timer) timer = setTimeout(() => { process.exitCode = 1; stop() }, timeout)
      void peer.receive(frame).catch(() => {
        // No upstream error strings on stdout/stderr: they may contain bearer material.
        process.stdout.write(`${JSON.stringify({ ...frame, kind: 'error', payload: {
          kind: 'unknown', message: 'Harness execution failed; preserve the run and inspect host diagnostics',
        } })}\n`)
        process.exitCode = 1
        stop()
      })
    } catch {
      process.exitCode = 1
      stop()
    }
  })
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  void main().catch(() => { console.error('OpenSlack peer deployment failed; check nonsecret configuration'); process.exitCode = 1 })
}
