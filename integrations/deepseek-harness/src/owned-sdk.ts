/** One SDK lifecycle, including initialization failure and cancellation before startup. Never call a lazy-start request to clean up an uninitialized client. */
import type { DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client'
import type { TaskSdk } from './bridge.ts'
import type { loadPublicHarness } from './runtime.ts'
import { isCleanExit, OwnedProcessObservation } from './process-observer.ts'
import type { SdkShutdownReceipt } from './process-observer.ts'

export interface OwnedSdkOptions {
  runtime: Awaited<ReturnType<typeof loadPublicHarness>>
  launch: DeepSeekHarnessOptions & { dshBin: string; profile: 'sdk'; patches: string[] }
  generation: string
  requireMcp: boolean
  authorize(method: string, params: Record<string, unknown>): Promise<unknown>
}

export function createOwnedSdk(config: OwnedSdkOptions): TaskSdk {
  const observed = new OwnedProcessObservation(process.execPath,
    [config.launch.dshBin, '--profile', 'sdk', ...config.launch.patches.flatMap(path => ['--patch', path])])
  const sdk = new config.runtime.sdk.DeepSeekHarness(config.launch)
  let initialized = false
  let attempted = false
  let closing = false
  let closeTask: Promise<Readonly<SdkShutdownReceipt>> | undefined
  const close = () => closeTask ??= (async () => {
    closing = true
    try {
      if (!initialized) return Object.freeze({ pid: -1, code: null, signal: null,
        terminationRequested: false, shutdownAcknowledged: false, resourcesStopped: false })
      const result = await sdk.client.request('openslack/prepare-shutdown', { generation: config.generation }, 10_000)
      if (!result || typeof result !== 'object' || !('generation' in result) || result.generation !== config.generation ||
        !('resources' in result) || !Array.isArray(result.resources) || result.resources.length !== (config.requireMcp ? 1 : 0) ||
        result.resources.some(item => !isCleanExit(item))) throw new Error('SDK owned-resource stop is unknown')
      const ack = await sdk.client.request('shutdown', undefined, 10_000)
      if (!ack || typeof ack !== 'object' || Array.isArray(ack) || Object.keys(ack).length) throw new Error('SDK shutdown ACK is invalid')
      const receipt = await observed.waitForClose(10_000)
      return Object.freeze({ ...receipt, shutdownAcknowledged: true, resourcesStopped: true })
    } finally {
      try { await sdk.close() } finally { observed.dispose() }
    }
  })()
  return {
    async run(text, sessionId, onNotification) {
      if (closing || attempted) throw new Error('SDK task already attempted or closed before startup')
      attempted = true
      await sdk.start()
      observed.assertRunning()
      if (closing) throw new Error('SDK startup was cancelled')
      initialized = true
      sdk.client.onRequest(async (method, params) => {
        observed.assertRunning()
        if (closing) throw new Error('SDK task is closing')
        const result = await config.authorize(method, params)
        observed.assertRunning()
        if (closing) throw new Error('SDK task closed during authorization')
        return result
      })
      return sdk.run(text, { sessionId, onNotification })
    },
    wait: async sessionId => {
      if (!initialized || closing) throw new Error('Cannot wait on an uninitialized or closed SDK task')
      await sdk.client.request('session/wait', { sessionId })
    },
    close,
  }
}
