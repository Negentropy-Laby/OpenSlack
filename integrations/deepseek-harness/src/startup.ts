/** Private STDIO Bridge peer; Harness applications still start through dsh --profile sdk. @module */
import { constants, fstatSync, lstatSync, openSync, closeSync, readSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { loadPublicHarness } from './runtime.ts'
import { createOwnedSdk } from './owned-sdk.ts'
import { OpenSlackPeer } from './bridge.ts'
import type { Config } from './index.ts'
import { HARNESS_CALLBACK_TOOLS } from '@openslack/agent-runtime/internal/bridge-wire'
import { assertEligibilityRestriction, readEligibilityRestriction } from './scope-evidence.ts'

interface WorkerBinding extends Config {
  resultMode: 'text' | 'json'
  runtimeEntries: Record<string, string>
  callbackMcp?: { cliModule: string; workspaceRoot: string; principalRef: string }
}

let peerDeadlineTimer: ReturnType<typeof setTimeout> | undefined

function options(args: string[]): Map<string, string> {
  const map = new Map<string, string>()
  const accepted = ['--harness-root', '--home', '--agent', '--provider', '--model', '--patch', '--binding', '--timeout-ms', '--start-eligibility-json']
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

export function readBinding(path: string): WorkerBinding {
  if (!isAbsolute(path)) throw new Error('Task binding path must be absolute')
  const ancestors = []
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const stamp = lstatSync(parent, { bigint: true })
    if (!stamp.isDirectory() || stamp.isSymbolicLink()) throw new Error('Task binding cannot traverse a directory link')
    ancestors.push({ path: parent, stamp })
    if (parent === dirname(parent)) break
  }
  const entry = lstatSync(path, { bigint: true })
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || entry.size > 128n * 1024n) throw new Error('Invalid task binding file')
  const file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(file, { bigint: true })
    const identity = (a: typeof before, b: typeof before) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
      a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
    if (!identity(entry, before)) throw new Error('Task binding changed before read')
    const bytes = Buffer.alloc(128 * 1024 + 1)
    let count = 0
    while (count < bytes.length) {
      const n = readSync(file, bytes, count, bytes.length - count, count)
      if (!n) break
      count += n
    }
    const after = fstatSync(file, { bigint: true })
    const final = lstatSync(path, { bigint: true })
    if (BigInt(count) !== before.size || count > 128 * 1024 || !identity(before, after) ||
      !final.isFile() || final.isSymbolicLink() || !identity(after, final)) throw new Error('Task binding changed during read')
    for (const ancestor of ancestors) {
      const current = lstatSync(ancestor.path, { bigint: true })
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== ancestor.stamp.dev ||
        current.ino !== ancestor.stamp.ino || current.mode !== ancestor.stamp.mode) throw new Error('Task binding ancestry changed')
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)))
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('resultMode' in value) ||
      (value.resultMode !== 'text' && value.resultMode !== 'json')) throw new Error('Invalid task output binding')
    // The same Loader Config schema validates this durable deployment input before Agent creation.
    return value as WorkerBinding
  } finally { closeSync(file) }
}

/** Own stdin, one task SDK, the per-launch patch, and shutdown through confirmed SDK exit. */
async function main(): Promise<void> {
  const deployment = options(process.argv.slice(2))
  const timeout = Number(deployment.get('--timeout-ms'))
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('Invalid peer deadline')
  // Includes dependency loading and the first handshake. No input is needed to
  // arm the cutoff; a silent/hung parent cannot leave an immortal peer.
  const deadline = performance.now() + timeout
  let stop: () => void = () => { process.exit(1) }
  const timer = setTimeout(() => { process.exitCode = 1; stop() }, timeout)
  peerDeadlineTimer = timer
  const binding = readBinding(required(deployment, '--binding'))
  const start: unknown = JSON.parse(required(deployment, '--start-eligibility-json'))
  if (!start || typeof start !== 'object' || Array.isArray(start) || Object.keys(start).sort().join(',') !== 'generation,restriction,runId' ||
    !('runId' in start) || start.runId !== binding.runId || !('generation' in start) || start.generation !== binding.generation || !('restriction' in start)) {
    throw new Error('Task start restriction is not bound to this run and generation')
  }
  const startEligibility = readEligibilityRestriction(start.restriction)
  assertEligibilityRestriction(startEligibility)
  const runtime = await loadPublicHarness(required(deployment, '--harness-root'))
  assertEligibilityRestriction(startEligibility)
  if (performance.now() >= deadline) { clearTimeout(timer); throw new Error('Peer startup deadline exceeded') }
  const { resultMode, callbackMcp, runtimeEntries, ...scopeBinding } = binding
  if (binding.callbacks && (!callbackMcp || !isAbsolute(callbackMcp.cliModule) || !isAbsolute(callbackMcp.workspaceRoot) ||
    !callbackMcp.principalRef || !callbackMcp.cliModule.endsWith('.js'))) throw new Error('Missing trusted task callback MCP deployment')
  let patchDirectory: string | undefined
  const peer = new OpenSlackPeer({
    validateEvent: runtime.sdk.validatedSessionEvent, expandStream: runtime.llm.expandAssistantStream,
    runId: binding.runId,
    resultMode,
    agentId: required(deployment, '--agent'), model: required(deployment, '--model'), root: binding.root,
    allowedTools: ['Read', 'Write', 'Edit', ...(binding.callbacks ? Object.values(HARNESS_CALLBACK_TOOLS).map(tool => tool.bridge) : [])],
    startEligibility,
    createSdk(systemText, allowedTools, authorize, recordResult) {
      assertEligibilityRestriction(startEligibility)
      patchDirectory = mkdtempSync(join(tmpdir(), 'openslack-sdk-'))
      const patch = join(patchDirectory, 'scope.patch.json')
      const config: Config = {
        ...scopeBinding, systemText: [binding.systemText, systemText].filter(Boolean).join('\n\n'),
        readPaths: allowedTools.includes('Read') ? binding.readPaths : [],
        writePaths: allowedTools.includes('Write') && allowedTools.includes('Edit') ? binding.writePaths : [],
        callbacks: binding.callbacks && Object.values(HARNESS_CALLBACK_TOOLS).every(tool => allowedTools.includes(tool.bridge)),
      }
      const mcp = callbackMcp && config.callbacks ? { mode: 'task' as const,
        workspaceRoot: callbackMcp.workspaceRoot, cliModule: callbackMcp.cliModule,
        principalRef: callbackMcp.principalRef, workerBinding: required(deployment, '--binding'), timeoutMs: timeout } : undefined
      writeFileSync(patch, JSON.stringify([
        { id: 'tool-executor-ptc', disabled: true },
        { id: 'tool-executor-native', disabled: false },
        { id: 'sdk-jsonrpc-server', disabled: true },
        { insert: [{ id: 'openslack-sdk-host', name: new URL('./sdk-host.js', import.meta.url).href,
          config: { generation: binding.generation, runtimeEntries: JSON.stringify(runtimeEntries), startEligibility: JSON.stringify(startEligibility), ...(mcp ? { mcp } : {}) } }] },
        { insert: [{ id: 'openslack-task-scope', name: new URL('./index.js', import.meta.url).href, config }] },
      ]), { flag: 'wx', mode: 0o600 })
      const patches = [required(deployment, '--patch'), patch]
      return Promise.resolve(createOwnedSdk({
        runtime, generation: binding.generation, requireMcp: !!mcp, startEligibility,
        launch: {
          dshBin: runtime.dshBin, dshHome: required(deployment, '--home'), profile: 'sdk', patches,
          processCwd: binding.root, cwd: binding.root,
          provider: required(deployment, '--provider'), model: required(deployment, '--model'),
          initializeTimeoutMs: Math.max(1, Math.floor(deadline - performance.now())), requestTimeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
        },
        async authorize(method, params) {
          if (!['openslack/tool-authorize', 'openslack/tool-evidence-result'].includes(method) || params.runId !== binding.runId ||
            params.taskId !== binding.taskId || params.principalId !== binding.principalId ||
            params.generation !== binding.generation) throw new Error('Unrelated SDK host request')
          if (method === 'openslack/tool-evidence-result') {
            if (typeof params.callId !== 'string' || (params.indeterminate !== undefined && params.indeterminate !== true)) throw new Error('Unrelated SDK evidence result')
            await recordResult(params.callId, params.output, params.indeterminate === true)
            return { recorded: true }
          } else {
            if (typeof params.toolName !== 'string') throw new Error('Unrelated SDK tool authorization')
            const restriction = await authorize(params.toolName, params.input, params.evidence as Parameters<typeof authorize>[2])
            return { allowed: true, restriction }
          }
        },
      }))
    },
  }, (frame, serialized) => { process.stdout.write(`${serialized ?? JSON.stringify(frame)}\n`) })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  const fail = (): void => { process.exitCode = 1; stop() }
  const onData = (bytes: Buffer): void => {
    try {
      pending += decoder.decode(bytes, { stream: true })
      let newline: number
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Peer wire frame exceeded its bound')
        void peer.receiveLine(line).catch(fail)
      }
      if (Buffer.byteLength(pending) > 1024 * 1024) throw new Error('Peer wire frame exceeded its bound')
    } catch { fail() }
  }
  const onEnd = (): void => {
    try { pending += decoder.decode(); if (pending.length) throw new Error('Truncated peer frame') }
    catch { process.exitCode = 1 }
    stop()
  }
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    clearTimeout(timer)
    process.stdin.off('data', onData)
    process.stdin.off('end', onEnd)
    process.stdin.pause()
    try { await peer.close() }
    finally {
      // A read already started before invalid input can keep a paused STDIO
      // pipe referenced. After owned shutdown, close only this transport so a
      // malformed pre-handshake frame cannot strand the otherwise idle peer.
      process.stdin.destroy()
    }
    // The generated launch patch is retained with the execution evidence.
  })()
  stop = (): void => { void close().catch(() => { process.exitCode = 1 }) }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  process.stdin.once('close', stop)
  process.stdin.once('error', fail)
  process.stdin.once('end', onEnd)
  process.stdin.on('data', onData)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  void main().catch(() => {
    if (peerDeadlineTimer) clearTimeout(peerDeadlineTimer)
    console.error('OpenSlack peer deployment failed; check nonsecret configuration')
    process.exitCode = 1
  })
}
