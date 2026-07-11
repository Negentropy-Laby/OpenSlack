import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  diagnoseOpenAICompatibleRuntime,
  runOpenAICompatibleRuntimeSmoke,
  setupOpenAICompatibleRuntime,
} from '../index.js';

function providerConfig(root: string): string {
  const dir = join(root, '.openslack.local');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'agent-runtime.json');
  writeFileSync(
    path,
    JSON.stringify({
      providers: {
        'openai-compatible': {
          baseUrl: 'https://example.test/v1',
          model: 'test-model',
          credentialRef: 'env:TEST_RUNTIME_KEY',
        },
      },
    }),
    'utf-8',
  );
  return path;
}

describe('OpenAI-compatible runtime diagnostics', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openslack-openai-diagnostics-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('distinguishes not configured, misconfigured, unavailable, and ready', async () => {
    expect((await diagnoseOpenAICompatibleRuntime({ rootDir: root, env: {} })).readiness).toBe(
      'not_configured',
    );

    providerConfig(root);
    expect((await diagnoseOpenAICompatibleRuntime({ rootDir: root, env: {} })).readiness).toBe(
      'misconfigured',
    );

    const unavailable = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(
      (
        await diagnoseOpenAICompatibleRuntime({
          rootDir: root,
          env: { TEST_RUNTIME_KEY: 'transport-only-test-value' },
          fetchImpl: unavailable,
        })
      ).readiness,
    ).toBe('unavailable');

    const ready = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const report = await diagnoseOpenAICompatibleRuntime({
      rootDir: root,
      env: { TEST_RUNTIME_KEY: 'transport-only-test-value' },
      fetchImpl: ready,
    });
    expect(report).toMatchObject({ status: 'PASS', readiness: 'ready' });
    expect(JSON.stringify(report)).not.toContain('transport-only-test-value');
  });

  it('is preview-first and merges non-secret config without deleting legacy providers', () => {
    const path = join(root, '.openslack.local', 'agent-runtime.json');
    mkdirSync(join(root, '.openslack.local'), { recursive: true });
    writeFileSync(path, JSON.stringify({ aby: { root: '../Aby', command: 'bun' } }), 'utf-8');
    const options = {
      rootDir: root,
      baseUrl: 'http://127.0.0.1:43121/v1',
      model: 'local-model',
      credentialRef: 'env:TEST_RUNTIME_KEY',
      env: {},
    };
    const preview = setupOpenAICompatibleRuntime(options);
    expect(preview).toMatchObject({ status: 'PASS', mode: 'dry-run', wroteConfig: false });
    expect(readFileSync(path, 'utf-8')).not.toContain('openai-compatible');

    const written = setupOpenAICompatibleRuntime({ ...options, write: true });
    expect(written).toMatchObject({
      status: 'PASS',
      mode: 'write',
      wroteConfig: true,
      readiness: 'misconfigured',
    });
    const saved = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(saved.aby).toEqual({ root: '../Aby', command: 'bun' });
    expect(saved.providers).toBeDefined();
    expect(readFileSync(path, 'utf-8')).not.toContain('transport-only-test-value');

    const repeated = setupOpenAICompatibleRuntime({
      ...options,
      env: { TEST_RUNTIME_KEY: 'transport-only-test-value' },
      write: true,
      maxOutputTokens: 2048,
    });
    expect(repeated).toMatchObject({ status: 'PASS', wroteConfig: true, readiness: 'ready' });
  });

  it('rejects raw credentials and invalid limits without writing', () => {
    const invalid = setupOpenAICompatibleRuntime({
      rootDir: root,
      baseUrl: 'https://user:password@example.test/v1',
      model: 'model',
      credentialRef: 'raw-secret-value',
      maxTurns: 1_000,
      write: true,
    });
    expect(invalid.status).toBe('FAIL');
    expect(invalid.wroteConfig).toBe(false);
    expect(existsSync(join(root, '.openslack.local', 'agent-runtime.json'))).toBe(false);
  });

  it('runs a live-protocol smoke against an injected endpoint and records evidence', async () => {
    providerConfig(root);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"summary":"connected"}' } }],
            usage: { total_tokens: 4 },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const report = await runOpenAICompatibleRuntimeSmoke({
      rootDir: root,
      env: { TEST_RUNTIME_KEY: 'transport-only-test-value' },
      fetchImpl,
    });
    expect(report).toMatchObject({ status: 'PASS', terminalReason: 'completed' });
    expect(report.evidence.runJson && existsSync(report.evidence.runJson)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('transport-only-test-value');
  });

  it('returns typed terminal smoke evidence for an invalid provider response', async () => {
    providerConfig(root);
    const fetchImpl = vi.fn(
      async () => new Response('not-json', { status: 200 }),
    ) as unknown as typeof fetch;
    const report = await runOpenAICompatibleRuntimeSmoke({
      rootDir: root,
      env: { TEST_RUNTIME_KEY: 'transport-only-test-value' },
      fetchImpl,
    });
    expect(report).toMatchObject({
      status: 'FAIL',
      terminalReason: 'failed',
      failureCode: 'PROVIDER_INVALID_RESPONSE',
    });
    expect(report.checks.find((check) => check.name === 'terminal-event')?.status).toBe('PASS');
  });
});
