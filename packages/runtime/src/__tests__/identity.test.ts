import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  generateRuntimeIdentity,
  loadRuntimeIdentity,
  resolveAgentPrincipal,
  resolveAgentStatusBinding,
} from '../identity.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const AGENT_ID = 'test_agent';

let fixtureRoot: string;
let cleanupConfirmed = true;

function writeRegistry(agentId = AGENT_ID): void {
  const registryDir = join(fixtureRoot, '.openslack', 'agents', 'registry');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(
    join(registryDir, `${agentId}.yaml`),
    `
schema: openslack.agent_registry.v1
agent_id: ${agentId}
display_name: Test Agent
vendor:
  provider: test
  runtime: local
employment:
  status: active
  hired_at: "2026-01-01T00:00:00.000Z"
capabilities:
  primary:
    - typescript
  secondary:
    - schema_design
repositories:
  workspace_repo:
    owner: test
    repo: OpenSlack
    default_branch: main
workspace_permissions:
  allow:
    - packages/**
  deny:
    - .openslack.local/**
execution:
  max_parallel_tasks: 1
  lease_ttl_minutes: 120
output_contract:
  must_create: []
  may_create: []
  must_not_create: []
approval_rules:
  require_human_approval_for: []
`,
    'utf-8',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanupConfirmed = true;
  fixtureRoot = join(
    tmpdir(),
    `openslack-identity-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(fixtureRoot, { recursive: true });
  writeRegistry();
});

afterEach(() => {
  if (cleanupConfirmed) rmSync(fixtureRoot, { recursive: true, force: true });
  else
    console.error(
      `Identity concurrency fixture retained after unconfirmed child exit: ${fixtureRoot}`,
    );
});

describe('generateRuntimeIdentity', () => {
  it('generates identity and writes to .openslack.local', () => {
    const identity = generateRuntimeIdentity({
      root: fixtureRoot,
      agentId: AGENT_ID,
      provider: 'cli',
    });

    expect(identity.schema).toBe('openslack.agent_runtime_identity.v1');
    expect(identity.agent_id).toBe(AGENT_ID);
    expect(identity.run_id).toMatch(/^RUN-/);
    expect(identity.provider).toBe('cli');
    expect(identity.started_at).toBeDefined();

    const identityPath = join(fixtureRoot, '.openslack.local', 'agents', AGENT_ID, 'identity.yaml');
    expect(existsSync(identityPath)).toBe(true);
  });

  it('creates an explicitly create-only identity that the production resolver reads back', () => {
    const issued = generateRuntimeIdentity({
      root: fixtureRoot,
      agentId: AGENT_ID,
      provider: 'cli',
      createOnly: true,
    });
    expect(loadRuntimeIdentity(fixtureRoot, AGENT_ID)).toEqual(issued);
    expect(
      resolveAgentPrincipal({ root: fixtureRoot, agentId: AGENT_ID, provider: 'cli' }),
    ).toMatchObject({
      principal: { registry_id: AGENT_ID, run_id: issued.run_id, provider: 'cli' },
    });
  });

  it.each([
    Buffer.from(
      'schema: openslack.agent_runtime_identity.v1\r\nrun_id: RUN-EXISTING\r\ncredentials: { canary: keep-existing-ref }\r\n# preserve exact bytes\r\n',
    ),
    Buffer.from([0xff, 0x00, 0xfe, 0x0a]),
  ])(
    'refuses create-only issuance without reading, merging or rewriting existing bytes %#',
    (bytes) => {
      const directory = join(fixtureRoot, '.openslack.local', 'agents', AGENT_ID);
      mkdirSync(directory, { recursive: true });
      const path = join(directory, 'identity.yaml');
      writeFileSync(path, bytes);
      expect(() =>
        generateRuntimeIdentity({
          root: fixtureRoot,
          agentId: AGENT_ID,
          provider: 'cli',
          createOnly: true,
        }),
      ).toThrowError(expect.objectContaining({ code: 'EEXIST' }));
      expect(vi.mocked(readFileSync).mock.calls.filter(([file]) => file === path)).toHaveLength(0);
      expect(readFileSync(path)).toEqual(bytes);
    },
  );

  it('rejects an occupied identity namespace instead of treating it as a missing file', () => {
    const path = join(fixtureRoot, '.openslack.local', 'agents', AGENT_ID, 'identity.yaml');
    mkdirSync(path, { recursive: true });
    expect(() =>
      generateRuntimeIdentity({
        root: fixtureRoot,
        agentId: AGENT_ID,
        provider: 'cli',
        createOnly: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'EEXIST' }));
    expect(existsSync(path)).toBe(true);
  });

  it('keeps the default existing-identity merge contract unchanged', () => {
    const directory = join(fixtureRoot, '.openslack.local', 'agents', AGENT_ID);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'identity.yaml');
    writeFileSync(
      path,
      'credentials: { canary: keep-existing-ref }\npaths: { root: keep-existing-path }\npreferences: { theme: keep-existing-theme }\n',
    );
    const issued = generateRuntimeIdentity({
      root: fixtureRoot,
      agentId: AGENT_ID,
      provider: 'cli',
    });
    expect(parseYaml(readFileSync(path, 'utf8'))).toMatchObject({
      ...issued,
      credentials: { canary: 'keep-existing-ref' },
      paths: { root: 'keep-existing-path' },
      preferences: { theme: 'keep-existing-theme' },
    });
  });

  it('publishes exactly one identity when two independent processes race after a readiness barrier', async () => {
    const source = fileURLToPath(new URL('../identity.ts', import.meta.url));
    const script = `
      const { generateRuntimeIdentity } = await import(process.argv[2]);
      process.send({ phase: 'ready' });
      await new Promise(resolve => process.once('message', resolve));
      try {
        const value = generateRuntimeIdentity({ root: process.argv[1], agentId: 'test_agent', provider: 'cli', createOnly: true });
        process.send({ phase: 'created', runId: value.run_id });
      } catch (error) { process.send({ phase: 'rejected', code: error.code }); }
      process.disconnect();
    `;
    const workers = Array.from({ length: 2 }, () => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          script,
          fixtureRoot,
          pathToFileURL(source).href,
        ],
        {
          cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          windowsHide: true,
        },
      );
      const errors: Buffer[] = [];
      let errorBytes = 0;
      child.stderr?.on('data', (chunk: Buffer) => {
        if (errorBytes < 16 * 1024) {
          errors.push(chunk.subarray(0, 16 * 1024 - errorBytes));
          errorBytes += chunk.length;
        }
      });
      let ready!: () => void;
      let failed!: (error: Error) => void;
      const readiness = new Promise<void>((resolve, reject) => {
        ready = resolve;
        failed = reject;
      });
      let outcome: Record<string, unknown> | undefined;
      let failDone!: (error: Error) => void;
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
      );
      const done = new Promise<Record<string, unknown>>((resolve, reject) => {
        failDone = reject;
        child.on('message', (message: unknown) => {
          if (!message || typeof message !== 'object' || !('phase' in message)) return;
          if (message.phase === 'ready') ready();
          else outcome = message as Record<string, unknown>;
        });
        void closed.then((receipt) => {
          clearTimeout(timer);
          if (receipt.code === 0 && receipt.signal === null && outcome) resolve(outcome);
          else {
            const error = new Error(
              `Identity fixture child exited without a successful IPC receipt: ${Buffer.concat(errors).toString('utf8')}`,
            );
            failed(error);
            reject(error);
          }
        });
        child.once('error', (error) => {
          failed(error);
          reject(error);
        });
      });
      const timer = setTimeout(() => {
        const error = new Error('Identity fixture child deadline exceeded');
        failed(error);
        failDone(error);
        child.kill();
      }, 20_000);
      void readiness.catch(() => undefined);
      void done.catch(() => undefined);
      return { child, readiness, done, closed, timer };
    });
    try {
      await Promise.all(workers.map((worker) => worker.readiness));
      for (const worker of workers) worker.child.send('issue');
      const outcomes = await Promise.all(workers.map((worker) => worker.done));
      expect(outcomes.filter((value) => value.phase === 'created')).toHaveLength(1);
      expect(outcomes.filter((value) => value.phase === 'rejected')).toEqual([
        { phase: 'rejected', code: 'EEXIST' },
      ]);
      const winner = outcomes.find((value) => value.phase === 'created')!;
      expect(loadRuntimeIdentity(fixtureRoot, AGENT_ID)?.run_id).toBe(winner.runId);
    } finally {
      for (const worker of workers) {
        clearTimeout(worker.timer);
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
      }
      const exited = await Promise.all(
        workers.map((worker) =>
          Promise.race([
            worker.closed.then(() => true),
            new Promise<false>((resolve) => {
              const timer = setTimeout(() => resolve(false), 1_000);
              timer.unref();
            }),
          ]),
        ),
      );
      cleanupConfirmed = exited.every(Boolean);
    }
  }, 30_000);
});

describe('loadRuntimeIdentity', () => {
  it('loads previously generated identity', () => {
    generateRuntimeIdentity({ root: fixtureRoot, agentId: AGENT_ID, provider: 'cli' });
    const loaded = loadRuntimeIdentity(fixtureRoot, AGENT_ID);

    expect(loaded).not.toBeNull();
    expect(loaded!.schema).toBe('openslack.agent_runtime_identity.v1');
    expect(loaded!.agent_id).toBe(AGENT_ID);
    expect(loaded!.run_id).toMatch(/^RUN-/);
  });

  it('returns null for nonexistent agent identity', () => {
    const result = loadRuntimeIdentity(fixtureRoot, 'nonexistent_agent_xyz');
    expect(result).toBeNull();
  });
});

describe('resolveAgentPrincipal', () => {
  it('returns a principal ID from the same registry read and preserves historical status after suspension', () => {
    generateRuntimeIdentity({ root: fixtureRoot, agentId: AGENT_ID, provider: 'cli' });
    const active = resolveAgentPrincipal({ root: fixtureRoot, agentId: AGENT_ID });
    expect(active).toMatchObject({ principalId: expect.any(String) });
    const registryPath = join(fixtureRoot, '.openslack', 'agents', 'registry', `${AGENT_ID}.yaml`);
    writeRegistry();
    const registry = readFileSync(registryPath, 'utf8');
    writeFileSync(registryPath, registry.replace('status: active', 'status: paused'));
    expect(resolveAgentPrincipal({ root: fixtureRoot, agentId: AGENT_ID })).toMatchObject({
      error: expect.any(String),
    });
    expect(resolveAgentStatusBinding({ root: fixtureRoot, agentId: AGENT_ID })).toMatchObject({
      principalId: expect.any(String),
      principal: { registry_id: AGENT_ID },
    });
  });
  it('fails closed when runtime identity is missing', () => {
    const result = resolveAgentPrincipal({ root: fixtureRoot, agentId: AGENT_ID, provider: 'cli' });

    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('No runtime identity');
    expect((result as { error: string }).error).toContain('bootstrap');
    expect(
      existsSync(join(fixtureRoot, '.openslack.local', 'agents', AGENT_ID, 'identity.yaml')),
    ).toBe(false);
  });

  it('resolves principal after identity is explicitly generated', () => {
    generateRuntimeIdentity({ root: fixtureRoot, agentId: AGENT_ID, provider: 'cli' });

    const result = resolveAgentPrincipal({ root: fixtureRoot, agentId: AGENT_ID });

    expect('error' in result).toBe(false);
    if ('principal' in result) {
      expect(result.principal.registry_id).toBe(AGENT_ID);
      expect(result.principal.run_id).toMatch(/^RUN-/);
      expect(result.snapshot.source).toBe('registry_v1');
    }
  });

  it('returns error for nonexistent agent', () => {
    const result = resolveAgentPrincipal({ root: fixtureRoot, agentId: 'nonexistent_agent' });
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('not found');
  });

  it('returns the same run_id on repeated calls', () => {
    generateRuntimeIdentity({ root: fixtureRoot, agentId: AGENT_ID, provider: 'cli' });

    const first = resolveAgentPrincipal({ root: fixtureRoot, agentId: AGENT_ID });
    const second = resolveAgentPrincipal({ root: fixtureRoot, agentId: AGENT_ID });

    expect('principal' in first).toBe(true);
    expect('principal' in second).toBe(true);
    if ('principal' in first && 'principal' in second) {
      expect(first.principal.run_id).toBe(second.principal.run_id);
    }
  });

  it('fails closed when the requested provider or runtime registry binding mismatches', () => {
    generateRuntimeIdentity({ root: fixtureRoot, agentId: AGENT_ID, provider: 'cli' });
    expect(
      resolveAgentPrincipal({ root: fixtureRoot, agentId: AGENT_ID, provider: 'github' }),
    ).toMatchObject({ error: expect.stringContaining('does not match') });

    const identityPath = join(fixtureRoot, '.openslack.local', 'agents', AGENT_ID, 'identity.yaml');
    const identity = loadRuntimeIdentity(fixtureRoot, AGENT_ID)!;
    writeFileSync(
      identityPath,
      [
        `schema: ${identity.schema}`,
        `agent_id: other_agent`,
        `agent_uid: ${identity.agent_uid}`,
        `run_id: ${identity.run_id}`,
        `public_key_jwk: null`,
        `key_id: null`,
        `key_generated_at: null`,
        `provider: cli`,
        `started_at: ${identity.started_at}`,
        '',
      ].join('\n'),
      'utf8',
    );
    expect(resolveAgentPrincipal({ root: fixtureRoot, agentId: AGENT_ID })).toMatchObject({
      error: expect.stringContaining('does not match'),
    });
  });
});
