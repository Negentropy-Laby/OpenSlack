/** Real built peer → public SDK → dsh sdk profile → Loader → native files and durable Session. */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { prepareSdkFixture } from './fixtures/sdk-profile.ts'

describe('built peer and actual SDK lifecycle (keyless)', () => {
  it.each(['linked', 'packed', 'mismatched-peer'] as const)('%s package authorizes before native effects, waits for SDK exit, and retains a readable Session', async (installation) => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-sdk-process-'))
    onTestFinished(({ task }) => {
      if (task.result?.state === 'pass') rmSync(root, { recursive: true, force: true })
      else console.error(`Keyless SDK failure retained at ${root}`)
    })
    const source = fileURLToPath(new URL('../', import.meta.url))
    let installSpec: string | undefined
    if (installation === 'packed') {
      const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', root]
      let command = 'npm'
      if (process.platform === 'win32') {
        // Node does not execute npm.cmd with shell:false. Invoke the public npm
        // bin from this pinned, complete Node installation without a shell.
        const npmRoot = join(dirname(process.execPath), 'node_modules/npm')
        const npm = JSON.parse(readFileSync(join(npmRoot, 'package.json'), 'utf8')) as {
          name: string; bin?: { npm?: string }
        }
        if (npm.name !== 'npm' || typeof npm.bin?.npm !== 'string') {
          throw new Error('The pinned Node installation must include the public npm CLI')
        }
        command = process.execPath
        args.unshift(resolve(npmRoot, npm.bin.npm))
      }
      const [packed] = JSON.parse(execFileSync(command, args,
        { cwd: source, encoding: 'utf8' })) as Array<{ filename: string; files: Array<{ path: string }> }>
      expect(packed!.files.map(file => file.path)).toContain('dist/startup.js')
      expect(packed!.files.some(file => /^(src|tests|node_modules|\.build)\//.test(file.path))).toBe(false)
      installSpec = join(root, packed!.filename)
    }
    const fixture = prepareSdkFixture(root, [
      { name: 'read', args: { file_path: 'fixture.txt' } },
      { name: 'write', args: { file_path: 'fixture.txt', content: 'after' } },
      'verified fixture output',
    ], installSpec)
    if (installation === 'mismatched-peer') {
      const binding = JSON.parse(readFileSync(fixture.binding, 'utf8'))
      binding.runtimeEntries['@deepseek-ai/schemastery'] = join(root, 'unapproved-public-entry.js')
      writeFileSync(fixture.binding, JSON.stringify(binding))
    }
    if (installation === 'packed') {
      expect(fixture.pluginRoot).not.toBe(source)
      expect(existsSync(join(fixture.pluginRoot, 'src'))).toBe(false)
      expect(existsSync(join(fixture.pluginRoot, 'node_modules'))).toBe(false)
    }
    const child = spawn(process.execPath, [join(fixture.pluginRoot, 'dist/startup.js'), '--harness-root', fixture.repository,
      '--home', fixture.home, '--agent', 'approved', '--provider', 'openslack-fixture', '--model', 'fixture',
      '--patch', fixture.patch, '--binding', fixture.binding, '--timeout-ms', '120000'], { stdio: 'pipe', env: { PATH: process.env.PATH } })
    onTestFinished(() => { if (child.exitCode === null) child.kill('SIGKILL') })
    const frames: Array<{ kind: string; payload: Record<string, unknown> }> = []
    let errors = ''
    child.stderr.on('data', (data: Buffer) => { errors += data.toString() })
    const lines = createInterface({ input: child.stdout })
    const send = (kind: string, payload: object) => child.stdin.write(`${JSON.stringify({
      protocolVersion: '2025-06-03', sessionId: 'bridge-RUN-TEST', correlationId: 'RUN-TEST',
      timestamp: new Date().toISOString(), kind, payload,
    })}\n`)
    lines.on('line', (line) => {
      const frame = JSON.parse(line) as { kind: string; payload: Record<string, unknown> }
      frames.push(frame)
      if (frame.kind === 'handshake_response') send('run_request', {
        runId: 'RUN-TEST', agentId: 'approved', worktreePath: fixture.workspace, model: 'fixture',
        allowedTools: ['Read', 'Write', 'Edit'], deniedTools: [],
        input: [{ role: 'system', content: 'TASK SYSTEM SENTINEL' }, { role: 'user', content: 'Change the fixed fixture' }],
      })
      if (frame.kind === 'tool_request' && frame.payload.phase === 'authorize') {
        expect(frame.payload.toolName).toMatch(/^(Read|Write|Edit)$/)
        send('tool_response', { authorizationRequestId: frame.payload.authorizationRequestId, allowed: true })
      }
      if (frame.kind === 'complete' || frame.kind === 'error') child.stdin.end()
    })
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => { resolve(code) })
    })
    send('handshake_request', { protocolVersion: '2025-06-03' })
    const code = await exited
    if (installation === 'mismatched-peer') {
      expect(code).not.toBe(0)
      expect(frames.some(frame => frame.kind === 'complete')).toBe(false)
      expect(existsSync(join(root, 'requests.jsonl'))).toBe(false)
      expect(readFileSync(join(fixture.workspace, 'fixture.txt'), 'utf8')).toBe('before')
      return
    }
    expect(code, errors).toBe(0)
    expect(frames.at(-1)).toMatchObject({ kind: 'complete', payload: { data: 'verified fixture output', usage: 'observed', tokenUsage: 33 } })
    expect(readFileSync(join(fixture.workspace, 'fixture.txt'), 'utf8')).toBe('after')
    const requests = readFileSync(join(root, 'requests.jsonl'), 'utf8')
    expect(requests).toContain('TASK SYSTEM SENTINEL')
    expect(requests.split('\n').filter(Boolean)).toHaveLength(3)
    const logs = readdirSync(join(root, 'logs'), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    expect(logs.length).toBeGreaterThan(0)
    const persisted = logs.map(entry => readFileSync(join(entry.parentPath, entry.name), 'utf8')).join('\n')
    expect(persisted).toContain('tool/call')
    expect(persisted).toContain('tool/result')
    expect(persisted).toContain('verified fixture output')
    expect(frames.filter(frame => frame.kind === 'tool_request' && frame.payload.phase === 'observed')).toHaveLength(2)
  }, 150_000)
})
