/** One SDK lifecycle, including initialization failure and cancellation before startup. Never call a lazy-start request to clean up an uninitialized client. */
import type { DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client'
import type { TaskSdk } from './bridge.ts'
import type { loadPublicHarness } from './runtime.ts'
import { isCleanExit, OwnedProcessObservation } from './process-observer.ts'
import type { SdkShutdownReceipt } from './process-observer.ts'
import { shutdownDeadline, shutdownRemaining, withinShutdown } from './shutdown.ts'
import { assertEligibilityRestriction, readEligibilityRestriction, type HarnessEligibilityRestriction } from './scope-evidence.ts'

export interface OwnedSdkOptions {
  runtime: Awaited<ReturnType<typeof loadPublicHarness>>
  launch: DeepSeekHarnessOptions & { dshBin: string; profile: 'sdk'; patches: string[] }
  generation: string
  requireMcp: boolean
  startEligibility: HarnessEligibilityRestriction
  authorize(method: string, params: Record<string, unknown>): Promise<unknown>
}

export function createOwnedSdk(config: OwnedSdkOptions): TaskSdk {
  const startEligibility = readEligibilityRestriction(config.startEligibility)
  const observed = new OwnedProcessObservation(process.execPath,
    [config.launch.dshBin, '--profile', 'sdk', ...config.launch.patches.flatMap(path => ['--patch', path])])
  const sdk = new config.runtime.sdk.DeepSeekHarness(config.launch)
  let initialized = false
  let attempted = false
  let closing = false
  let closeTask: Promise<Readonly<SdkShutdownReceipt>> | undefined
  const close = () => closeTask ??= (async () => {
    closing = true
    const deadline = shutdownDeadline()
    try {
      if (!initialized) {
        // start() has already synchronously spawned before awaiting initialize.
        // Never wait for initialize before requesting public, non-lazy cleanup.
        await withinShutdown(deadline, () => sdk.close())
        if (!attempted) return Object.freeze({ pid: -1, code: null, signal: null,
          terminationRequested: false, shutdownAcknowledged: false, resourcesStopped: false })
        const receipt = await observed.waitForClose(shutdownRemaining(deadline))
        return Object.freeze({ ...receipt, shutdownAcknowledged: false, resourcesStopped: false })
      }
      const result = await sdk.client.request('openslack/prepare-shutdown', {
        generation: config.generation, remainingMs: shutdownRemaining(deadline),
      }, shutdownRemaining(deadline))
      if (!result || typeof result !== 'object' || !('generation' in result) || result.generation !== config.generation ||
        !('resources' in result) || !Array.isArray(result.resources) || result.resources.length !== (config.requireMcp ? 1 : 0) ||
        result.resources.some(item => !isCleanExit(item))) throw new Error('SDK owned-resource stop is unknown')
      const ack = await sdk.client.request('shutdown', undefined, shutdownRemaining(deadline))
      if (!ack || typeof ack !== 'object' || Array.isArray(ack) || Object.keys(ack).length) throw new Error('SDK shutdown ACK is invalid')
      const receipt = await observed.waitForClose(shutdownRemaining(deadline))
      return Object.freeze({ ...receipt, shutdownAcknowledged: true, resourcesStopped: true })
    } finally {
      try {
        // close() is a public non-lazy cleanup, unlike session/wait or shutdown.
        // Invoke it even after the deadline, but never restart the close budget.
        const cleanup = sdk.close()
        if (performance.now() < deadline) await withinShutdown(deadline, () => cleanup)
        else { void cleanup.catch(() => {}); throw new Error('SDK cleanup exceeded the owned shutdown deadline') }
      } finally { observed.dispose() }
    }
  })()
  return {
    async run(text, sessionId, onNotification) {
      if (closing || attempted) throw new Error('SDK task already attempted or closed before startup')
      assertEligibilityRestriction(startEligibility)
      attempted = true
      await sdk.start()
      initialized = true
      observed.assertRunning()
      if (closing) throw new Error('SDK startup was cancelled')
      assertEligibilityRestriction(startEligibility)
      sdk.client.onRequest(async (method, params) => {
        observed.assertRunning()
        if (closing) throw new Error('SDK task is closing')
        const result = await config.authorize(method, params)
        observed.assertRunning()
        if (closing) throw new Error('SDK task closed during authorization')
        return result
      })
      assertEligibilityRestriction(startEligibility)
      return sdk.run(text, { sessionId, onNotification })
    },
    wait: async sessionId => {
      if (!initialized || closing) throw new Error('Cannot wait on an uninitialized or closed SDK task')
      await sdk.client.request('session/wait', { sessionId })
    },
    close,
  }
}
