/** Real built peer → public SDK → dsh sdk profile → Loader → native files and durable Session. */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { prepareSdkFixture } from './fixtures/sdk-profile.ts'
import { publicAliases } from '../runtime-public.mjs'

describe('built peer and actual SDK lifecycle (keyless)', () => {
  it('denies the first adapter dispatch after a public Agent preparation await crosses the known lease', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-peer-last-dispatch-'));
    onTestFinished(({ task }) => { if (task.result?.state === 'pass') rmSync(root, { recursive: true, force: true }); });
    const fixture = prepareSdkFixture(root, ['must never reach the scripted model']);
    const expiryFile = join(root, 'known-expiry.txt'), marker = join(root, 'agent-request-await.json');
    const profile = join(fixture.home, 'profiles/sdk/cordis.patch.yml');
    const rows = JSON.parse(readFileSync(profile, 'utf8')) as Array<{ insert: Array<{ id?: string; config?: Record<string, unknown> }> }>;
    const model = rows[0]!.insert.find(row => row.id === 'fixture-model');
    if (!model?.config) throw new Error('The explicit public fixture model is missing');
    model.config.requestGate = { expiryFile, marker };
    writeFileSync(profile, JSON.stringify(rows));
    const expiresAt = Date.now() + 15_000;
    writeFileSync(expiryFile, String(expiresAt), { flag: 'wx' });
    const child = spawn(process.execPath, [join(fixture.pluginRoot, 'dist/startup.js'), '--harness-root', fixture.repository,
      '--home', fixture.home, '--agent', 'approved', '--provider', 'openslack-fixture', '--model', 'fixture',
      '--patch', fixture.patch, '--binding', fixture.binding, '--timeout-ms', '30000', '--start-eligibility-json',
      JSON.stringify({ runId: 'RUN-TEST', generation: 'fixture-g1', restriction: { mode: 'required', expiresAt } })],
    { stdio: 'pipe', env: { PATH: process.env.PATH } });
    onTestFinished(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    child.stderr.resume(); child.stdin.on('error', () => {});
    const frames: Array<{ kind: string }> = [];
    const send = (kind: string, payload: object) => child.stdin.write(JSON.stringify({ protocolVersion: '2025-06-03',
      sessionId: 'bridge-RUN-TEST', correlationId: 'RUN-TEST', timestamp: new Date().toISOString(), kind, payload }) + '\n');
    createInterface({ input: child.stdout }).on('line', line => {
      const frame = JSON.parse(line) as { kind: string }; frames.push(frame);
      if (frame.kind === 'handshake_response') send('run_request', { runId: 'RUN-TEST', agentId: 'approved', worktreePath: fixture.workspace,
        model: 'fixture', allowedTools: ['Read'], deniedTools: [], input: [{ role: 'user', content: 'Respond without tools' }] });
      if (frame.kind === 'complete' || frame.kind === 'error') child.stdin.end();
    });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    send('handshake_request', { protocolVersion: '2025-06-03' });
    const code = await exited;
    const waited = JSON.parse(readFileSync(marker, 'utf8')) as { enteredAt: number; expiresAt: number; finishedAt: number };
    expect(waited.enteredAt).toBeLessThan(waited.expiresAt);
    expect(waited.finishedAt).toBeGreaterThanOrEqual(waited.expiresAt);
    console.info(JSON.stringify({ scope: 'real SDK public Agent preparation crosses required lease', fixture: root, waited, code,
      completed: frames.some(frame => frame.kind === 'complete'), modelRequested: existsSync(join(root, 'requests.jsonl')) }));
    expect(code).not.toBe(0);
    expect(frames.some(frame => frame.kind === 'complete')).toBe(false);
    expect(existsSync(join(root, 'requests.jsonl'))).toBe(false);
    expect(readFileSync(join(fixture.workspace, 'fixture.txt'), 'utf8')).toBe('before');
  }, 35_000);
  it.each(['missing', 'expired', 'foreign-run', 'foreign-generation'] as const)('rejects a %s start restriction before any model action', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-peer-start-restriction-'));
    onTestFinished(({ task }) => { if (task.result?.state === 'pass') rmSync(root, { recursive: true, force: true }); });
    const fixture = prepareSdkFixture(root, ['must not execute']);
    const start = { runId: mode === 'foreign-run' ? 'RUN-OTHER' : 'RUN-TEST',
      generation: mode === 'foreign-generation' ? 'foreign-generation' : 'fixture-g1',
      restriction: mode === 'expired' ? { mode: 'required', expiresAt: Date.now() - 1 } : { mode: 'not_applicable' } };
    const child = spawn(process.execPath, [join(fixture.pluginRoot, 'dist/startup.js'), '--harness-root', fixture.repository,
      '--home', fixture.home, '--agent', 'approved', '--provider', 'openslack-fixture', '--model', 'fixture',
      '--patch', fixture.patch, '--binding', fixture.binding, '--timeout-ms', '1000',
      ...(mode === 'missing' ? [] : ['--start-eligibility-json', JSON.stringify(start)])], { stdio: 'pipe', env: { PATH: process.env.PATH } });
    child.stdout.resume(); child.stderr.resume(); child.stdin.on('error', () => {});
    onTestFinished(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    expect(code).not.toBe(0);
    expect(existsSync(join(root, 'requests.jsonl'))).toBe(false);
    expect(readFileSync(join(fixture.workspace, 'fixture.txt'), 'utf8')).toBe('before');
  }, 10_000);
  it.each(['silent-parent', 'invalid-utf8', 'truncated'] as const)('%s exits before any SDK/model action', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-peer-no-handshake-'));
    onTestFinished(({ task }) => { if (task.result?.state === 'pass') rmSync(root, { recursive: true, force: true }); });
    const fixture = prepareSdkFixture(root, []);
    const started = Date.now();
    const child = spawn(process.execPath, [join(fixture.pluginRoot, 'dist/startup.js'), '--harness-root', fixture.repository,
      '--home', fixture.home, '--agent', 'approved', '--provider', 'openslack-fixture', '--model', 'fixture',
      '--patch', fixture.patch, '--binding', fixture.binding, '--timeout-ms', '1000', '--start-eligibility-json',
      JSON.stringify({ runId: 'RUN-TEST', generation: 'fixture-g1', restriction: { mode: 'not_applicable' } })], { stdio: 'pipe', env: { PATH: process.env.PATH } });
    child.stdout.resume(); child.stderr.resume(); child.stdin.on('error', () => {});
    onTestFinished(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (mode === 'invalid-utf8') child.stdin.write(Buffer.from([0xff, 10]));
    if (mode === 'truncated') child.stdin.end('{"protocolVersion":');
    expect(await exited).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(join(root, 'requests.jsonl'))).toBe(false);
    expect(readFileSync(join(fixture.workspace, 'fixture.txt'), 'utf8')).toBe('before');
  }, 10_000);
  it.each(['linked', 'packed', 'mismatched-peer'] as const)('%s package authorizes before native effects, waits for SDK exit, and retains a readable Session', async (installation) => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-sdk-process-'))
    const safeFailure: { stage: string; installation: string; peerExit?: { pid: number | null; code: number | null; signal: string | null; terminationRequested: boolean };
      stderrBytes: number; frameKinds: string[]; observedToolResults: number; sdkShutdownReceipt: null } = {
      stage: 'fixture-prepare', installation, stderrBytes: 0, frameKinds: [], observedToolResults: 0, sdkShutdownReceipt: null,
    }
    onTestFinished(({ task }) => {
      if (task.result?.state === 'pass') rmSync(root, { recursive: true, force: true })
      else {
        // Only known phases, public frame kinds and actual exit facts: never
        // persist an upstream error message, raw frame payload or bearer.
        writeFileSync(join(root, 'peer-failure-summary.json'), JSON.stringify(safeFailure), { flag: 'wx' })
        console.error(JSON.stringify({ code: 'KEYLESS_PEER_EXIT_OR_ASSERTION_FAILED', fixture: root, ...safeFailure }))
      }
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
      expect(packed!.files.map(file => file.path)).toContain('dist/openslack-harness-supervisor.exe')
      expect(packed!.files.map(file => file.path)).toContain('THIRD-PARTY-NOTICES.txt')
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
      for (const name of readdirSync(join(fixture.pluginRoot, 'dist/types/src')).filter(name => name.endsWith('.d.ts'))) {
        expect(readFileSync(join(fixture.pluginRoot, 'dist/types/src', name), 'utf8')).not.toContain('@openslack/agent-runtime')
      }
      // A fresh consumer resolves the four real package exports, with only the
      // approved Harness public declarations supplied. No OpenSlack workspace
      // package or node_modules ancestor may supply a missing private type.
      const consumer = join(root, 'type-consumer')
      mkdirSync(join(consumer, 'node_modules/@openslack'), { recursive: true })
      symlinkSync(fixture.pluginRoot, join(consumer, 'node_modules/@openslack/deepseek-harness-plugin'),
        process.platform === 'win32' ? 'junction' : 'dir')
      writeFileSync(join(consumer, 'package.json'), '{"type":"module","private":true}')
      writeFileSync(join(consumer, 'consumer.ts'), [
        'import * as worker from "@openslack/deepseek-harness-plugin";',
        'import * as initiator from "@openslack/deepseek-harness-plugin/initiator";',
        'import * as readonly from "@openslack/deepseek-harness-plugin/readonly";',
        'import * as sdkHost from "@openslack/deepseek-harness-plugin/sdk-host";',
        'export const exports = [worker.apply, initiator.apply, readonly.apply, sdkHost.apply];',
      ].join('\n'))
      const config = join(consumer, 'tsconfig.json')
      writeFileSync(config, JSON.stringify({ compilerOptions: { target: 'ES2024', module: 'ESNext',
        moduleResolution: 'Bundler', noEmit: true, strict: true, skipLibCheck: false,
        types: ['node'], typeRoots: [join(fixture.repository, 'node_modules/@types')],
        paths: Object.fromEntries(Object.entries(publicAliases(fixture.repository, true)).map(([name, path]) => [name, [path]])),
      }, files: ['./consumer.ts'] }))
      execFileSync(process.execPath, [join(fixture.repository, 'node_modules/typescript/bin/tsc'), '-p', config],
        { cwd: consumer, stdio: 'pipe', timeout: 60_000 })
    }
    safeFailure.stage = 'peer-start'
    const child = spawn(process.execPath, [join(fixture.pluginRoot, 'dist/startup.js'), '--harness-root', fixture.repository,
      '--home', fixture.home, '--agent', 'approved', '--provider', 'openslack-fixture', '--model', 'fixture',
      '--patch', fixture.patch, '--binding', fixture.binding, '--timeout-ms', '120000', '--start-eligibility-json',
      JSON.stringify({ runId: 'RUN-TEST', generation: 'fixture-g1', restriction: { mode: 'not_applicable' } })], { stdio: 'pipe', env: { PATH: process.env.PATH } })
    onTestFinished(() => { if (child.exitCode === null) child.kill('SIGKILL') })
    const frames: Array<{ kind: string; payload: Record<string, unknown> }> = []
    child.stderr.on('data', (data: Buffer) => { safeFailure.stderrBytes += data.length })
    const lines = createInterface({ input: child.stdout })
    const send = (kind: string, payload: object) => child.stdin.write(`${JSON.stringify({
      protocolVersion: '2025-06-03', sessionId: 'bridge-RUN-TEST', correlationId: 'RUN-TEST',
      timestamp: new Date().toISOString(), kind, payload,
    })}\n`)
    lines.on('line', (line) => {
      const frame = JSON.parse(line) as { kind: string; payload: Record<string, unknown> }
      frames.push(frame)
      const known = ['handshake_response', 'run_started', 'tool_request', 'tool_response', 'complete', 'error']
      safeFailure.frameKinds.push(known.includes(frame.kind) ? frame.kind : 'unrecognized')
      safeFailure.stage = frame.kind === 'complete' ? 'terminal-complete' : frame.kind === 'error' ? 'terminal-error'
        : frame.kind === 'run_started' ? 'task-started' : safeFailure.stage
      if (frame.kind === 'tool_response' && frame.payload.phase === 'observed') safeFailure.observedToolResults++
      if (frame.kind === 'handshake_response') send('run_request', {
        runId: 'RUN-TEST', agentId: 'approved', worktreePath: fixture.workspace, model: 'fixture',
        allowedTools: ['Read', 'Write', 'Edit'], deniedTools: [],
        input: [{ role: 'system', content: 'TASK SYSTEM SENTINEL' }, { role: 'user', content: 'Change the fixed fixture' }],
      })
      if (frame.kind === 'tool_request' && frame.payload.phase === 'authorize') {
        expect(frame.payload.toolName).toMatch(/^(Read|Write|Edit)$/)
        send('tool_response', { authorizationRequestId: frame.payload.authorizationRequestId, allowed: true,
          restriction: { mode: 'not_applicable' } })
      }
      if (frame.kind === 'complete' || frame.kind === 'error') child.stdin.end()
    })
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        safeFailure.peerExit = { pid: child.pid ?? null, code, signal, terminationRequested: child.killed }
        resolve(code)
      })
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
    expect(code, JSON.stringify(safeFailure)).toBe(0)
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
