import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentBudgetExceededError,
  AgentExecutionFailedError,
  AgentRunCancelledError,
  AgentLimitExceededError,
  buildPermissionProfile,
  createOpenSlackAgentLauncher,
  createRunRecorder,
  createRunStore,
  loadOpenAICompatibleRuntimeConfig,
  OpenAICompatibleExecutionAdapter,
  PermissionDeniedError,
  ProviderInvalidResponseError,
  ProviderTimeoutError,
  readTranscript,
  RepositoryToolExecutor,
  requestAgentRunCancellation,
  RuntimeMisconfiguredError,
  ToolArgumentInvalidError,
  ToolGuard,
} from '../index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createContext(root: string, options: { mode?: 'plan' | 'default'; tokens?: number } = {}) {
  const runId = 'RUN-20260711-OPENAICOMPAT';
  const store = createRunStore(root);
  const recorder = createRunRecorder(store, root);
  const permissionProfile = buildPermissionProfile({
    agentId: 'provider-test',
    source: 'test',
    permissionMode: options.mode ?? 'plan',
  });
  const runState = recorder.start({
    runId,
    agentId: 'provider-test',
    prompt: 'test',
    resolvedConfig: {
      agentId: 'provider-test',
      source: 'test',
      runtimeProvider: 'openai-compatible',
      model: 'test-model',
    },
    permissionProfile,
    budget: { tokens: options.tokens ?? 100, costUsd: 0 },
  });
  const toolGuard = new ToolGuard(permissionProfile, recorder, runId);
  const toolExecutor = new RepositoryToolExecutor({
    rootPath: root,
    toolGuard,
    recorder,
    runId,
  });
  return {
    store,
    context: {
      prompt: 'inspect the repository',
      runId,
      agentId: 'provider-test',
      resolvedConfig: {
        agentId: 'provider-test',
        source: 'test',
        runtimeProvider: 'openai-compatible',
        model: 'test-model',
      },
      permissionProfile,
      recorder,
      runState,
      toolGuard,
      toolExecutor,
    },
  };
}

function adapter(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof OpenAICompatibleExecutionAdapter>[0]> = {},
) {
  return new OpenAICompatibleExecutionAdapter({
    providerId: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    credentialRef: 'env:TEST_RUNTIME_KEY',
    apiKey: 'transport-only-test-value',
    timeoutMs: 2_000,
    maxTurns: 4,
    maxToolCalls: 4,
    maxOutputTokens: 50,
    maxResponseBytes: 64 * 1024,
    maxToolResultBytes: 64 * 1024,
    fetchImpl,
    ...overrides,
  });
}

describe('OpenAI-compatible agent runtime', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openslack-openai-runtime-'));
    writeFileSync(join(root, 'README.md'), 'runtime fixture\n', 'utf-8');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('runs a governed multi-turn tool loop with wire-name mapping and usage charging', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const { context, store } = createContext(root, { tokens: 40 });
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        // A future runtime host may refresh this object after chargeUsage. The
        // adapter must continue from its immutable launch-time budget snapshot.
        context.runState.tokensRemaining = 30;
        return jsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'repo_read', arguments: '{"path":"README.md"}' },
                  },
                ],
              },
            },
          ],
          usage: { total_tokens: 10 },
        });
      }
      return jsonResponse({
        choices: [{ message: { content: '{"summary":"done"}' } }],
        usage: { total_tokens: 7 },
      });
    }) as unknown as typeof fetch;
    const result = await adapter(fetchImpl).execute<{ summary: string }>(context);

    expect(result.data).toEqual({ summary: 'done' });
    expect(result.tokenUsage).toBe(17);
    expect(result.tokenUsageRecorded).toBe(true);
    expect(store.getRun(context.runId)).toMatchObject({ tokensUsed: 17, tokensRemaining: 23 });
    expect(
      (requests[0].tools as Array<{ function: { name: string } }>).map(
        (tool) => tool.function.name,
      ),
    ).toEqual(expect.arrayContaining(['repo_read', 'repo_search', 'repo_diff']));
    expect(requests[0].max_tokens).toBe(40);
    expect(requests[1].max_tokens).toBe(30);
    expect(JSON.stringify(requests[1])).toContain('runtime fixture');
  });

  it('redacts known credential shapes before sending the user prompt', async () => {
    const fakeToken = `sk-${'b'.repeat(24)}`;
    let requestBody = '';
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body);
      return jsonResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { total_tokens: 1 },
      });
    }) as unknown as typeof fetch;
    const { context } = createContext(root);
    context.prompt = `Do not expose ${fakeToken}`;
    await adapter(fetchImpl).execute(context);
    expect(requestBody).not.toContain(fakeToken);
    expect(requestBody).toContain('[redacted-token]');
  });

  it('reuses context-aware source projections without leaking literals to the provider or transcript', async () => {
    const fakeToken = `sk-${'p'.repeat(24)}`;
    const fakePassword = 'provider-source-password';
    writeFileSync(
      join(root, 'source.ts'),
      [
        'const secret = getSecret();',
        `const password = "${fakePassword}";`,
        `const token = "${fakeToken}";`,
        '',
      ].join('\n'),
      'utf-8',
    );
    const requests: string[] = [];
    let turn = 0;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(init?.body));
      turn += 1;
      return turn === 1
        ? jsonResponse({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'read-source',
                      type: 'function',
                      function: { name: 'repo_read', arguments: '{"path":"source.ts"}' },
                    },
                  ],
                },
              },
            ],
            usage: { total_tokens: 2 },
          })
        : jsonResponse({
            choices: [{ message: { content: '{"summary":"safe"}' } }],
            usage: { total_tokens: 2 },
          });
    }) as unknown as typeof fetch;
    const { context } = createContext(root);

    await adapter(fetchImpl).execute(context);

    expect(requests).toHaveLength(2);
    const secondRequest = JSON.parse(requests[1]) as {
      messages: Array<{ role: string; content: string }>;
    };
    const toolMessage = secondRequest.messages.find((message) => message.role === 'tool');
    const toolResult = JSON.parse(toolMessage!.content) as {
      data: { content: string };
    };
    expect(toolResult.data.content).toContain('const secret = getSecret();');
    expect(toolResult.data.content).toContain('const password = "[redacted]";');
    expect(toolResult.data.content).toContain('const token = "[redacted]";');
    expect(requests[1]).not.toContain(fakePassword);
    expect(requests[1]).not.toContain(fakeToken);
    const transcript = JSON.stringify(readTranscript(context.runId, root));
    expect(transcript).toContain('getSecret()');
    expect(transcript).not.toContain(fakePassword);
    expect(transcript).not.toContain(fakeToken);
  });

  it('fails closed on missing usage and still charges usage that exceeds the token budget', async () => {
    const missingUsage = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
      }),
    ) as unknown as typeof fetch;
    await expect(adapter(missingUsage).execute(createContext(root).context)).rejects.toBeInstanceOf(
      ProviderInvalidResponseError,
    );

    rmSync(join(root, '.openslack.local'), { recursive: true, force: true });
    const overBudget = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { total_tokens: 6 },
      }),
    ) as unknown as typeof fetch;
    const { context, store } = createContext(root, { tokens: 5 });
    await expect(adapter(overBudget).execute(context)).rejects.toBeInstanceOf(
      AgentBudgetExceededError,
    );
    expect(store.getRun(context.runId)).toMatchObject({ tokensUsed: 6, tokensRemaining: -1 });
  });

  it('distinguishes invalid tool arguments, denied tools, and safety limits', async () => {
    const invalidArgs = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'bad-args',
                  type: 'function',
                  function: { name: 'repo_read', arguments: '{"path":"README.md","extra":true}' },
                },
              ],
            },
          },
        ],
        usage: { total_tokens: 1 },
      }),
    ) as unknown as typeof fetch;
    await expect(adapter(invalidArgs).execute(createContext(root).context)).rejects.toBeInstanceOf(
      ToolArgumentInvalidError,
    );

    rmSync(join(root, '.openslack.local'), { recursive: true, force: true });
    const denied = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'denied',
                  type: 'function',
                  function: {
                    name: 'repo_apply_patch',
                    arguments: '{"path":"blocked.txt","oldText":"","newText":"x"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { total_tokens: 1 },
      }),
    ) as unknown as typeof fetch;
    await expect(
      adapter(denied).execute(createContext(root, { mode: 'plan' }).context),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    rmSync(join(root, '.openslack.local'), { recursive: true, force: true });
    const oversized = vi.fn(async () => new Response('x'.repeat(200))) as unknown as typeof fetch;
    await expect(
      adapter(oversized, { maxResponseBytes: 32 }).execute(createContext(root).context),
    ).rejects.toBeInstanceOf(AgentLimitExceededError);

    rmSync(join(root, '.openslack.local'), { recursive: true, force: true });
    const truncated = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: 'partial output' }, finish_reason: 'length' }],
        usage: { total_tokens: 2 },
      }),
    ) as unknown as typeof fetch;
    await expect(adapter(truncated).execute(createContext(root).context)).rejects.toBeInstanceOf(
      AgentLimitExceededError,
    );
  });

  it('distinguishes provider timeout from outer cancellation', async () => {
    const hanging = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    ) as unknown as typeof fetch;
    await expect(
      adapter(hanging, { timeoutMs: 100 }).execute(createContext(root).context),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);

    rmSync(join(root, '.openslack.local'), { recursive: true, force: true });
    const slowBody = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
          }),
        ),
    ) as unknown as typeof fetch;
    await expect(
      adapter(slowBody, { timeoutMs: 100 }).execute(createContext(root).context),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('loads only non-secret config and rejects unknown or invalid fields', () => {
    const configDir = join(root, '.openslack.local');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'agent-runtime.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          'openai-compatible': {
            baseUrl: 'http://127.0.0.1:43121/v1',
            model: 'local-model',
            credentialRef: 'env:TEST_RUNTIME_KEY',
            timeoutMs: 500,
          },
        },
      }),
      'utf-8',
    );
    const config = loadOpenAICompatibleRuntimeConfig({ configPath, env: {} });
    expect(config).toMatchObject({
      baseUrl: 'http://127.0.0.1:43121/v1',
      model: 'local-model',
      credentialRef: 'env:TEST_RUNTIME_KEY',
    });
    expect(readFileSync(configPath, 'utf-8')).not.toContain('transport-only-test-value');

    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          'openai-compatible': {
            model: 'bad',
            credentialRef: 'env:TEST_RUNTIME_KEY',
            apiKey: 'forbidden',
          },
        },
      }),
      'utf-8',
    );
    expect(() => loadOpenAICompatibleRuntimeConfig({ configPath, env: {} })).toThrow(
      RuntimeMisconfiguredError,
    );

    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          'openai-compatible': {
            model: 'bad',
            credentialRef: 'env:TEST_RUNTIME_KEY',
            maxTurns: 'many',
          },
        },
      }),
      'utf-8',
    );
    expect(() => loadOpenAICompatibleRuntimeConfig({ configPath, env: {} })).toThrow(
      RuntimeMisconfiguredError,
    );
  });

  it('wires the provider through the default registry and fails the run before schema completion', async () => {
    const configDir = join(root, '.openslack.local');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'agent-runtime.json'),
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
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: '{"wrong":true}' } }],
        usage: { total_tokens: 3 },
      }),
    ) as unknown as typeof fetch;
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      openAICompatible: { env: { TEST_RUNTIME_KEY: 'transport-only-test-value' }, fetchImpl },
    });
    await expect(
      launcher('return a summary', {
        label: 'provider-test',
        phase: 'test',
        budget: { tokens: 20, costUsd: 0 },
        schema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
          additionalProperties: false,
        },
        resolvedAgentConfig: {
          agentId: 'provider-test',
          source: 'test',
          runtimeProvider: 'openai-compatible',
          permissionMode: 'plan',
        },
      }),
    ).rejects.toMatchObject({
      name: AgentExecutionFailedError.name,
      code: 'PROVIDER_INVALID_RESPONSE',
    });

    const run = store.listRuns()[0];
    expect(run).toMatchObject({
      status: 'failed',
      failureCode: 'PROVIDER_INVALID_RESPONSE',
      tokensUsed: 3,
    });
    const transcript = readTranscript(run.runId, root);
    expect(transcript.some((event) => event.type === 'complete')).toBe(false);
    expect(transcript.some((event) => event.type === 'fail')).toBe(true);
    expect(JSON.stringify(transcript)).not.toContain('transport-only-test-value');
  });

  it('isolates a write-capable provider in a disposable worktree and preserves its real diff', async () => {
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf-8' });
      if (result.status !== 0) throw new Error(String(result.stderr));
    };
    git(['init', '--quiet']);
    git(['config', 'user.name', 'OpenSlack Test']);
    git(['config', 'user.email', 'openslack-test@example.invalid']);
    git(['add', 'README.md']);
    git(['commit', '--quiet', '-m', 'fixture']);
    const configDir = join(root, '.openslack.local');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'agent-runtime.json'),
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
    let turn = 0;
    const fetchImpl = vi.fn(async () => {
      turn += 1;
      return turn === 1
        ? jsonResponse({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'write-1',
                      type: 'function',
                      function: {
                        name: 'repo_apply_patch',
                        arguments:
                          '{"path":"provider-output.txt","oldText":"","newText":"real edit\\n"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { total_tokens: 5 },
          })
        : jsonResponse({
            choices: [{ message: { content: '{"summary":"edited"}' } }],
            usage: { total_tokens: 3 },
          });
    }) as unknown as typeof fetch;
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      openAICompatible: { env: { TEST_RUNTIME_KEY: 'transport-only-test-value' }, fetchImpl },
    });
    const result = await launcher<{ summary: string }>('create provider-output.txt', {
      label: 'writer',
      phase: 'test',
      budget: { tokens: 50 },
      resolvedAgentConfig: {
        agentId: 'writer',
        source: 'test',
        runtimeProvider: 'openai-compatible',
        permissionMode: 'default',
      },
    });
    expect(result.data).toEqual({ summary: 'edited' });
    expect(existsSync(join(root, 'provider-output.txt'))).toBe(false);
    const run = store.getRun(result.runId);
    expect(run?.worktreeHandoff?.worktreePath).toBeTruthy();
    expect(
      readFileSync(join(run!.worktreeHandoff!.worktreePath, 'provider-output.txt'), 'utf-8'),
    ).toBe('real edit\n');
  });

  it('persists distinct terminal failure evidence for provider, tool, and token failures', async () => {
    const configDir = join(root, '.openslack.local');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'agent-runtime.json'),
      JSON.stringify({
        providers: {
          'openai-compatible': {
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            credentialRef: 'env:TEST_RUNTIME_KEY',
            timeoutMs: 100,
          },
        },
      }),
      'utf-8',
    );
    const cases: Array<{ code: string; budget?: number; fetchImpl: typeof fetch }> = [
      {
        code: 'PROVIDER_UNAVAILABLE',
        fetchImpl: vi.fn(async () => {
          throw new Error('raw transport detail');
        }) as unknown as typeof fetch,
      },
      {
        code: 'PROVIDER_INVALID_RESPONSE',
        fetchImpl: vi.fn(async () => new Response('not-json')) as unknown as typeof fetch,
      },
      {
        code: 'TOOL_ARGUMENT_INVALID',
        fetchImpl: vi.fn(async () =>
          jsonResponse({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'invalid',
                      type: 'function',
                      function: {
                        name: 'repo_read',
                        arguments: '{"path":"README.md","extra":true}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { total_tokens: 1 },
          }),
        ) as unknown as typeof fetch,
      },
      {
        code: 'TOOL_DENIED',
        fetchImpl: vi.fn(async () =>
          jsonResponse({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'denied',
                      type: 'function',
                      function: {
                        name: 'repo_apply_patch',
                        arguments: '{"path":"blocked.txt","oldText":"","newText":"x"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { total_tokens: 1 },
          }),
        ) as unknown as typeof fetch,
      },
      {
        code: 'BUDGET_EXCEEDED',
        budget: 2,
        fetchImpl: vi.fn(async () =>
          jsonResponse({
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { total_tokens: 3 },
          }),
        ) as unknown as typeof fetch,
      },
      {
        code: 'PROVIDER_TIMEOUT',
        fetchImpl: vi.fn(
          async (_input: string | URL | Request, init?: RequestInit) =>
            await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                once: true,
              });
            }),
        ) as unknown as typeof fetch,
      },
    ];
    for (const failureCase of cases) {
      const store = createRunStore(root);
      const launcher = createOpenSlackAgentLauncher({
        runStore: store,
        rootDir: root,
        openAICompatible: {
          env: { TEST_RUNTIME_KEY: 'transport-only-test-value' },
          fetchImpl: failureCase.fetchImpl,
        },
      });
      await expect(
        launcher('failure evidence', {
          label: 'failure-test',
          phase: 'test',
          budget: { tokens: failureCase.budget ?? 20 },
          resolvedAgentConfig: {
            agentId: 'failure-test',
            source: 'test',
            runtimeProvider: 'openai-compatible',
            permissionMode: 'plan',
          },
        }),
      ).rejects.toBeDefined();
      const run = store.listRuns().at(0)!;
      expect(run).toMatchObject({ status: 'failed', failureCode: failureCase.code });
      expect(JSON.stringify(readTranscript(run.runId, root))).not.toContain('raw transport detail');
    }
  });

  it('records outer cancellation as cancelled rather than a provider timeout', async () => {
    const configDir = join(root, '.openslack.local');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'agent-runtime.json'),
      JSON.stringify({
        providers: {
          'openai-compatible': {
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            credentialRef: 'env:TEST_RUNTIME_KEY',
            timeoutMs: 5000,
          },
        },
      }),
      'utf-8',
    );
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      markStarted();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as unknown as typeof fetch;
    const store = createRunStore(root);
    const runId = 'RUN-20260711-CANCELPROVIDER';
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      openAICompatible: { env: { TEST_RUNTIME_KEY: 'transport-only-test-value' }, fetchImpl },
    });
    const pending = launcher('wait for cancellation', {
      label: 'cancel-test',
      phase: 'test',
      agentRunId: runId,
      resolvedAgentConfig: {
        agentId: 'cancel-test',
        source: 'test',
        runtimeProvider: 'openai-compatible',
        permissionMode: 'plan',
      },
    });
    await started;
    expect(requestAgentRunCancellation(runId).status).toBe('cancelled');
    await expect(pending).rejects.toBeInstanceOf(AgentRunCancelledError);
    expect(store.getRun(runId)).toMatchObject({ status: 'cancelled' });
  });
});
