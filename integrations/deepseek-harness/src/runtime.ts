/** Public package entry loading for the peer process outside Harness's Loader. */
import { createRequire } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as HarnessSdk from '@deepseek-ai/dsh-sdk-client'
import type * as HarnessLlm from '@deepseek-ai/dsh-llm'
import { requireSupportedNode } from './process-observer.ts'

export async function loadPublicHarness(harnessRoot: string) {
  requireSupportedNode()
  const sdkManifestPath = join(harnessRoot, 'packages/sdk/client/package.json')
  const cliManifestPath = join(harnessRoot, 'apps/cli/package.json')
  const sdk = JSON.parse(readFileSync(sdkManifestPath, 'utf8')) as { name: string; version: string }
  const cli = JSON.parse(readFileSync(cliManifestPath, 'utf8')) as { name: string; version: string; bin: { dsh: string } }
  if (sdk.name !== '@deepseek-ai/dsh-sdk-client' || cli.name !== '@deepseek-ai/dsh' ||
    sdk.version !== '0.2.1-rc.3' || cli.version !== sdk.version || typeof cli.bin?.dsh !== 'string') {
    throw new Error('Unqualified Harness public SDK/dsh pair')
  }
  const sdkEntry = createRequire(sdkManifestPath).resolve(sdk.name)
  const llmEntry = createRequire(join(harnessRoot, 'packages/llm/llm/package.json')).resolve('@deepseek-ai/dsh-llm')
  const dshBin = resolve(harnessRoot, 'apps/cli', cli.bin.dsh)
  if (!statSync(dshBin).isFile()) throw new Error('Build the original dsh executable before dispatch')
  const sdkModule: typeof HarnessSdk = await import(pathToFileURL(sdkEntry).href)
  const llm: typeof HarnessLlm = await import(pathToFileURL(llmEntry).href)
  return { sdk: sdkModule, llm, dshBin }
}
