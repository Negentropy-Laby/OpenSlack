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
  getProviderUsageEvidence,
  loadOpenAICompatibleRuntimeConfig,
  OpenAICompatibleExecutionAdapter,
  PermissionDeniedError,
  ProviderInvalidResponseError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  readTranscript,
  RepositoryToolExecutor,
  requestAgentRunCancellation,
  RuntimeMisconfiguredError,
  ToolArgumentInvalidError,
  ToolGuard,
  type ProviderAttemptPort,
} from '../index.js';
import { createProviderAttemptBoundary } from '../internal/provider-attempt-boundary.js';

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
          usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
        });
      }
      return jsonResponse({
        choices: [{ message: { content: '{"summary":"done"}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    }) as unknown as typeof fetch;
    const result = await adapter(fetchImpl).execute<{ summary: string }>(context);

    expect(result.data).toEqual({ summary: 'done' });
    expect(result.tokenUsage).toBe(17);
    expect(result.tokenUsageRecorded).toBe(true);
    expect(result.usageEvidence).toHaveLength(2);
    expect(result.usageEvidence?.map((receipt) => receipt.attempt)).toEqual(['1', '2']);
    expect(result.usageEvidence?.map((receipt) => receipt.totalTokens)).toEqual(['10', '7']);
    expect(result.usageEvidence?.map((receipt) => receipt.inputTokens)).toEqual(['6', '5']);
    expect(result.usageEvidence?.map((receipt) => receipt.outputTokens)).toEqual(['4', '2']);
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

  it('reserves and settles every real HTTP turn through a host-minted boundary', async () => {
    const events: string[] = [];
    const reservations = [
      { reservationId: 'reservation-1', callId: 'call-1', authorizedTokens: '20' },
      { reservationId: 'reservation-2', callId: 'call-2', authorizedTokens: '15' },
    ] as const;
    const port: ProviderAttemptPort = {
      async reserve(input) {
        events.push(`reserve:${input.providerAttempt}:${input.requestedTokens}`);
        return reservations[Number(input.providerAttempt) - 1]!;
      },
      async settle(reservation, usage) {
        events.push(
          `settle:${usage.attempt}:${reservation.reservationId}:${usage.outcome}:${usage.totalTokens}`,
        );
      },
    };
    let turn = 0;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      turn += 1;
      const request = JSON.parse(String(init?.body)) as { max_tokens: number };
      events.push(`fetch:${turn}:${request.max_tokens}`);
      if (turn === 1) {
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
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
        });
      }
      return jsonResponse({
        choices: [{ message: { content: '{"summary":"done"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    }) as unknown as typeof fetch;
    const { context } = createContext(root, { tokens: 40 });

    await expect(
      adapter(fetchImpl, {
        providerAttemptBoundary: createProviderAttemptBoundary(port),
      }).execute<{ summary: string }>(context),
    ).resolves.toMatchObject({ data: { summary: 'done' }, tokenUsage: 17 });
    expect(events).toEqual([
      'reserve:1:40',
      'fetch:1:20',
      'settle:1:reservation-1:provider_response_accepted:10',
      'reserve:2:30',
      'fetch:2:15',
      'settle:2:reservation-2:provider_response_accepted:7',
    ]);
  });

  it('settles a failed real HTTP attempt and does not retry without a new reservation', async () => {
    const events: string[] = [];
    const port: ProviderAttemptPort = {
      async reserve(input) {
        events.push(`reserve:${input.providerAttempt}`);
        return { reservationId: 'reservation-1', callId: 'call-1', authorizedTokens: '20' };
      },
      async settle(_reservation, usage) {
        events.push(`settle:${usage.attempt}:${usage.outcome}:${usage.status}`);
      },
    };
    const fetchImpl = vi.fn(async () => {
      events.push('fetch:1');
      return jsonResponse({ error: 'unavailable' }, 503);
    }) as unknown as typeof fetch;
    const { context } = createContext(root, { tokens: 40 });

    await expect(
      adapter(fetchImpl, {
        providerAttemptBoundary: createProviderAttemptBoundary(port),
      }).execute(context),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(events).toEqual(['reserve:1', 'fetch:1', 'settle:1:provider_attempt_failed:unreported']);
  });

  it('settles an open reservation when local authorization validation fails before fetch', async () => {
    const events: string[] = [];
    const port: ProviderAttemptPort = {
      async reserve(input) {
        events.push(`reserve:${input.providerAttempt}:${input.requestedTokens}`);
        return {
          reservationId: 'reservation-1',
          callId: 'call-1',
          authorizedTokens: String(Number(input.requestedTokens) + 1),
        };
      },
      async settle(_reservation, usage) {
        events.push(`settle:${usage.attempt}:${usage.outcome}:${usage.status}`);
      },
    };
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const { context } = createContext(root, { tokens: 40 });

    await expect(
      adapter(fetchImpl, {
        providerAttemptBoundary: createProviderAttemptBoundary(port),
      }).execute(context),
    ).rejects.toBeInstanceOf(RuntimeMisconfiguredError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(events).toEqual(['reserve:1:40', 'settle:1:provider_attempt_failed:unreported']);
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
    let missingUsageError: unknown;
    try {
      await adapter(missingUsage).execute(createContext(root).context);
    } catch (error) {
      missingUsageError = error;
    }
    expect(missingUsageError).toBeInstanceOf(ProviderInvalidResponseError);
    expect(getProviderUsageEvidence(missingUsageError)).toMatchObject([
      {
        attempt: '1',
        calls: '1',
        status: 'unreported',
        totalTokens: null,
        outcome: 'provider_attempt_failed',
      },
    ]);

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

  it('keeps optional provider usage splits compatible while preserving an exact total', async () => {
    const variants: Array<Record<string, unknown>> = [
      { prompt_tokens: null, completion_tokens: null, total_tokens: 10 },
      { prompt_tokens: '6', completion_tokens: '4', total_tokens: 10 },
      { prompt_tokens: 6.5, completion_tokens: 3.5, total_tokens: 10 },
      { prompt_tokens: 6, completion_tokens: 4, total_tokens: 11 },
    ];

    for (const [index, usage] of variants.entries()) {
      const caseRoot = join(root, `optional-usage-${index}`);
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, 'README.md'), 'runtime fixture\n', 'utf-8');
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage,
        }),
      ) as unknown as typeof fetch;
      const { context, store } = createContext(caseRoot);

      const result = await adapter(fetchImpl).execute(context);

      expect(result.usageEvidence).toMatchObject([
        { inputTokens: null, outputTokens: null, totalTokens: String(usage.total_tokens) },
      ]);
      expect(store.getRun(context.runId)).toMatchObject({ tokensUsed: usage.total_tokens });
    }
  });

  it('rejects totals that cannot be represented as exact provider evidence', async () => {
    const totals = [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];
    for (const [index, total_tokens] of totals.entries()) {
      const caseRoot = join(root, `invalid-total-${index}`);
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, 'README.md'), 'runtime fixture\n', 'utf-8');
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { total_tokens },
        }),
      ) as unknown as typeof fetch;
      let failure: unknown;
      try {
        await adapter(fetchImpl).execute(createContext(caseRoot).context);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ProviderInvalidResponseError);
      expect(getProviderUsageEvidence(failure)).toMatchObject([
        { status: 'unreported', totalTokens: null, outcome: 'provider_attempt_failed' },
      ]);
    }
  });

  it('keeps budget exhaustion ahead of malformed provider response classification', async () => {
    const responseBodies = [
      { choices: [], usage: { total_tokens: 6 } },
      {
        choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
        usage: { total_tokens: 6 },
      },
    ];
    for (const [index, body] of responseBodies.entries()) {
      const caseRoot = join(root, `budget-priority-${index}`);
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, 'README.md'), 'runtime fixture\n', 'utf-8');
      const fetchImpl = vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch;
      const { context, store } = createContext(caseRoot, { tokens: 5 });
      let failure: unknown;
      try {
        await adapter(fetchImpl).execute(context);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AgentBudgetExceededError);
      expect(getProviderUsageEvidence(failure)).toMatchObject([
        { status: 'reported', totalTokens: '6', outcome: 'provider_attempt_failed' },
      ]);
      expect(store.getRun(context.runId)).toMatchObject({ tokensUsed: 6, tokensRemaining: -1 });
    }
  });

  it('retains ordered reported receipts when a later provider attempt has no usage', async () => {
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
                      id: 'read-before-failure',
                      type: 'function',
                      function: { name: 'repo_read', arguments: '{"path":"README.md"}' },
                    },
                  ],
                },
              },
            ],
            usage: { total_tokens: 3 },
          })
        : jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] });
    }) as unknown as typeof fetch;

    let failure: unknown;
    try {
      await adapter(fetchImpl).execute(createContext(root).context);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProviderInvalidResponseError);
    expect(getProviderUsageEvidence(failure)).toMatchObject([
      {
        attempt: '1',
        status: 'reported',
        totalTokens: '3',
        outcome: 'provider_response_accepted',
      },
      {
        attempt: '2',
        status: 'unreported',
        totalTokens: null,
        outcome: 'provider_attempt_failed',
      },
    ]);
    expect(Object.keys(failure as object)).not.toContain('usageEvidence');
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
    let invalidArgsError: unknown;
    try {
      await adapter(invalidArgs).execute(createContext(root).context);
    } catch (error) {
      invalidArgsError = error;
    }
    expect(invalidArgsError).toBeInstanceOf(ToolArgumentInvalidError);
    expect(getProviderUsageEvidence(invalidArgsError)).toMatchObject([
      {
        status: 'reported',
        totalTokens: '1',
        // The provider response is syntactically accepted; the governed local
        // tool schema rejects it later. Outcome never claims agent success.
        outcome: 'provider_response_accepted',
      },
    ]);

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

  it('executes a valid tool prefix before rejecting the next call at the tool limit', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'valid-prefix',
                  type: 'function',
                  function: { name: 'repo_read', arguments: '{"path":"README.md"}' },
                },
                {
                  id: 'malformed-after-limit',
                  type: 'function',
                  function: { name: 'repo_read', arguments: '{' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { total_tokens: 1 },
      }),
    ) as unknown as typeof fetch;
    const { context } = createContext(root);
    let failure: unknown;
    try {
      await adapter(fetchImpl, { maxToolCalls: 1 }).execute(context);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AgentLimitExceededError);
    expect(
      readTranscript(context.runId, root).filter((event) => event.type === 'tool_call'),
    ).toHaveLength(1);
    expect(getProviderUsageEvidence(failure)).toMatchObject([
      { status: 'reported', totalTokens: '1', outcome: 'provider_response_accepted' },
    ]);
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
    expect(() => adapter(vi.fn() as unknown as typeof fetch, { maxTurns: 33 })).toThrow(
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
    let failure: unknown;
    try {
      await launcher('return a summary', {
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
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: AgentExecutionFailedError.name,
      code: 'PROVIDER_INVALID_RESPONSE',
    });
    expect(getProviderUsageEvidence(failure)).toMatchObject([
      {
        attempt: '1',
        status: 'reported',
        totalTokens: '3',
        outcome: 'provider_response_accepted',
      },
    ]);
    expect((failure as { tokenUsage?: number }).tokenUsage).toBe(3);
    expect(Object.keys(failure as object)).not.toContain('tokenUsage');
    expect(Object.keys(failure as object)).not.toContain('usageEvidence');

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
  }, 15_000);

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
