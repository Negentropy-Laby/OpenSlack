/** Observe actual SDK-owned processes through Node's public, version-pinned channel; never patch spawn or SDK internals. */
import { ChildProcess } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { resolve } from 'node:path'

export const REQUIRED_NODE_VERSION = '24.18.1'
export interface ProcessExitReceipt {
  pid: number
  code: number | null
  signal: NodeJS.Signals | null
  terminationRequested: boolean
}
export interface SdkShutdownReceipt extends ProcessExitReceipt {
  shutdownAcknowledged: boolean
  resourcesStopped: boolean
}

export function requireSupportedNode(): void {
  if (process.versions.node !== REQUIRED_NODE_VERSION) throw new Error('OpenSlack requires the qualified Node 24.18.1 runtime')
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
}

/** One exact command/argv capture. The callback records facts without throwing or logging the ChildProcess/environment. */
export class OwnedProcessObservation {
  private child: ChildProcess | undefined
  private failure = false
  private result: ProcessExitReceipt | undefined
  private readonly ended = Promise.withResolvers<ProcessExitReceipt>()
  private readonly diagnostic = channel('child_process')
  private readonly observe = (value: unknown): void => {
    try {
      if (!value || typeof value !== 'object' || !('process' in value) || !(value.process instanceof ChildProcess)) return
      const child = value.process
      // Node announces construction before spawnfile/argv/PID are assigned. Bind only at the real spawn event.
      child.once('spawn', () => {
        try {
          if (!samePath(child.spawnfile, this.command) || child.spawnargs.length !== this.args.length + 1 ||
            !this.args.every((arg, index) => child.spawnargs[index + 1] === arg)) return
          if (this.child) { this.failure = true; return }
          this.child = child
          child.once('error', () => { this.failure = true })
          child.once('close', (code, signal) => {
            const pid = child.pid
            if (!Number.isSafeInteger(pid) || !pid || this.failure) this.failure = true
            this.result = { pid: pid ?? -1, code, signal, terminationRequested: child.killed }
            this.ended.resolve(this.result)
          })
        } catch { this.failure = true }
      })
    } catch { this.failure = true }
  }

  constructor(private readonly command: string, private readonly args: readonly string[]) {
    requireSupportedNode()
    this.diagnostic.subscribe(this.observe)
  }

  /** Must be checked after startup and before the first model request. */
  assertCaptured(expectedPid?: number | null): void {
    if (this.failure || !this.child?.pid || (expectedPid !== undefined && expectedPid !== this.child.pid)) {
      throw new Error('Owned process observation unavailable or ambiguous; execution is forbidden')
    }
  }

  assertRunning(): void {
    this.assertCaptured()
    if (this.result || this.child!.exitCode !== null || this.child!.signalCode !== null || this.child!.killed) {
      throw new Error('Owned process is no longer executing')
    }
  }

  async waitForClose(timeoutMs: number): Promise<ProcessExitReceipt> {
    this.assertCaptured()
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid process close bound')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = this.result ?? await Promise.race([this.ended.promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned process exit is unknown; preserve and reconcile')), timeoutMs)
      })])
      if (this.failure) throw new Error('Owned process observation failed')
      return Object.freeze({ ...result })
    } finally { if (timer) clearTimeout(timer) }
  }

  dispose(): void { this.diagnostic.unsubscribe(this.observe) }
}

export function isCleanExit(receipt: unknown): receipt is ProcessExitReceipt {
  return !!receipt && typeof receipt === 'object' && 'code' in receipt && receipt.code === 0 &&
    'signal' in receipt && receipt.signal === null && 'terminationRequested' in receipt && receipt.terminationRequested === false &&
    'pid' in receipt && typeof receipt.pid === 'number' && Number.isSafeInteger(receipt.pid) && receipt.pid > 0
}
