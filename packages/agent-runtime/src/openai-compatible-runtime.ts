import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentBudgetExceededError,
  AgentLimitExceededError,
  ProviderInvalidResponseError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  RuntimeMisconfiguredError,
  ToolArgumentInvalidError,
} from './types.js';
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AgentExecutionAdapter,
} from './adapter.js';
import { redactSensitiveText } from './sensitive-data.js';
import type { RepositoryToolName } from './tool-executor.js';

export interface OpenAICompatibleRuntimeConfig {
  providerId: 'openai-compatible';
  baseUrl: string;
  model: string;
  credentialRef: string;
  timeoutMs: number;
  maxTurns: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  maxResponseBytes: number;
  maxToolResultBytes: number;
}

export interface OpenAICompatibleRuntimeOptions {
  rootDir?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface OpenAICompatibleAdapterOptions extends OpenAICompatibleRuntimeConfig {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

const CONFIG_KEYS = new Set([
  'baseUrl',
  'model',
  'credentialRef',
  'timeoutMs',
  'maxTurns',
  'maxToolCalls',
  'maxOutputTokens',
  'maxResponseBytes',
  'maxToolResultBytes',
]);

export function loadOpenAICompatibleRuntimeConfig(
  options: OpenAICompatibleRuntimeOptions = {},
): OpenAICompatibleRuntimeConfig | null {
  const env = options.env ?? process.env;
  const path =
    options.configPath ??
    join(options.rootDir ?? process.cwd(), '.openslack.local', 'agent-runtime.json');
  let fileConfig: Record<string, unknown> | undefined;
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    } catch {
      throw new RuntimeMisconfiguredError('Agent runtime configuration is not valid JSON.');
    }
    const root = readRecord(parsed);
    const providers = readRecord(root?.providers);
    fileConfig =
      readRecord(providers?.['openai-compatible']) ?? readRecord(root?.['openai-compatible']);
    if (fileConfig) validateConfigShape(fileConfig);
  }

  const environmentProvider = readString(env.OPENSLACK_LLM_PROVIDER)?.toLowerCase();
  const enabledByEnvironment =
    environmentProvider === 'openai-compatible' || environmentProvider === 'openai';
  if (!fileConfig && !enabledByEnvironment) return null;

  const baseUrl =
    readString(fileConfig?.baseUrl) ??
    readString(env.OPENSLACK_LLM_BASE_URL) ??
    'https://api.openai.com/v1';
  const model = readString(fileConfig?.model) ?? readString(env.OPENSLACK_LLM_MODEL);
  const credentialRef =
    readString(fileConfig?.credentialRef) ??
    (readString(env.OPENSLACK_LLM_API_KEY) ? 'env:OPENSLACK_LLM_API_KEY' : undefined);
  if (!model)
    throw new RuntimeMisconfiguredError('OpenAI-compatible runtime model is not configured.');
  if (model.length > 200)
    throw new RuntimeMisconfiguredError('OpenAI-compatible runtime model is invalid.');
  if (!credentialRef) {
    throw new RuntimeMisconfiguredError(
      'OpenAI-compatible runtime credentialRef is not configured.',
    );
  }
  validateBaseUrl(baseUrl);

  return {
    providerId: 'openai-compatible',
    baseUrl: normalizeBaseUrl(baseUrl),
    model,
    credentialRef,
    timeoutMs: readBoundedInteger(fileConfig, 'timeoutMs', 60_000, 100, 600_000),
    maxTurns: readBoundedInteger(fileConfig, 'maxTurns', 8, 1, 32),
    maxToolCalls: readBoundedInteger(fileConfig, 'maxToolCalls', 24, 1, 128),
    maxOutputTokens: readBoundedInteger(fileConfig, 'maxOutputTokens', 4_096, 1, 128_000),
    maxResponseBytes: readBoundedInteger(
      fileConfig,
      'maxResponseBytes',
      2 * 1024 * 1024,
      1,
      16 * 1024 * 1024,
    ),
    maxToolResultBytes: readBoundedInteger(
      fileConfig,
      'maxToolResultBytes',
      256 * 1024,
      256,
      2 * 1024 * 1024,
    ),
  };
}

export function resolveRuntimeCredential(
  credentialRef: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!credentialRef.startsWith('env:')) {
    throw new RuntimeMisconfiguredError(
      'Only env: credential references are supported until CredentialStore is configured.',
    );
  }
  const key = credentialRef.slice('env:'.length);
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new RuntimeMisconfiguredError('Agent runtime credentialRef is invalid.');
  }
  const value = env[key];
  if (!value || !value.trim()) {
    throw new RuntimeMisconfiguredError('Agent runtime credential is unavailable.');
  }
  return value;
}

export class OpenAICompatibleExecutionAdapter implements AgentExecutionAdapter {
  readonly adapterId = 'openai-compatible';

  constructor(private readonly options: OpenAICompatibleAdapterOptions) {}

  async execute<T>(context: AdapterExecutionContext): Promise<AdapterExecutionResult<T>> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const endpoint = this.options.baseUrl.endsWith('/chat/completions')
      ? this.options.baseUrl
      : `${this.options.baseUrl}/chat/completions`;
    const definitions = context.toolExecutor.listDefinitions();
    const messages: OpenAIMessage[] = [
      {
        role: 'system',
        content: [
          'You are an OpenSlack repository agent.',
          'Use only the provided governed repository tools.',
          'Never request shell execution or credentials.',
          'Return the final result as JSON when the task requests a structured result.',
        ].join(' '),
      },
      { role: 'user', content: redactSensitiveText(context.prompt).value },
    ];
    let tokenUsage = 0;
    let toolCalls = 0;
    const startedAt = Date.now();
    // AgentRunState is the immutable launch-time budget snapshot for this
    // execution. Recorder chargeUsage persists fresh states, so all per-turn
    // calculations use this captured value plus the local usage accumulator.
    const initialTokensRemaining = context.runState.tokensRemaining;

    for (let turn = 0; turn < this.options.maxTurns; turn += 1) {
      throwIfAborted(context.signal);
      if (Date.now() - startedAt >= this.options.timeoutMs) {
        throw new ProviderTimeoutError();
      }
      const remaining =
        initialTokensRemaining === null
          ? this.options.maxOutputTokens
          : initialTokensRemaining - tokenUsage;
      if (remaining <= 0) throw new AgentBudgetExceededError();
      const maxTokens = Math.min(this.options.maxOutputTokens, remaining);
      const response = await fetchWithTimeout(
        fetchImpl,
        endpoint,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: context.resolvedConfig.model ?? this.options.model,
            messages,
            tools: definitions.map((definition) => ({
              type: 'function',
              function: {
                name: toWireToolName(definition.name),
                description: definition.description,
                parameters: definition.inputSchema,
              },
            })),
            tool_choice: definitions.length > 0 ? 'auto' : undefined,
            max_tokens: maxTokens,
          }),
        },
        Math.max(1, this.options.timeoutMs - (Date.now() - startedAt)),
        context.signal,
      );
      if (!response.ok) {
        if (response.status === 408 || response.status === 504) throw new ProviderTimeoutError();
        if (response.status === 401 || response.status === 403) {
          throw new RuntimeMisconfiguredError(
            'OpenAI-compatible provider rejected its credential.',
          );
        }
        if (response.status === 429 || response.status >= 500) {
          throw new ProviderUnavailableError();
        }
        throw new ProviderInvalidResponseError('OpenAI-compatible provider rejected the request.');
      }
      let raw: string;
      try {
        raw = await readResponseTextBounded(
          response,
          this.options.maxResponseBytes,
          Math.max(1, this.options.timeoutMs - (Date.now() - startedAt)),
          context.signal,
        );
      } catch (error) {
        if (
          context.signal?.aborted ||
          error instanceof ProviderTimeoutError ||
          error instanceof AgentLimitExceededError
        ) {
          throw error;
        }
        throw new ProviderUnavailableError();
      }
      const body = parseProviderResponse(raw);
      const used = readUsage(body.usage);
      tokenUsage += used;
      context.recorder.chargeUsage(context.runId, used);
      if (initialTokensRemaining !== null && tokenUsage > initialTokensRemaining) {
        throw new AgentBudgetExceededError();
      }
      const providerChoice = body.choices?.[0];
      const choice = providerChoice?.message;
      if (!choice) throw new ProviderInvalidResponseError();
      context.recorder.progress(context.runId, {
        step: 'provider_turn_completed',
        provider: 'openai-compatible',
        turn: turn + 1,
        tokenUsage: used,
        usageStatus: 'reported',
        costStatus: 'unknown',
      });

      const requestedTools = choice.tool_calls ?? [];
      if (requestedTools.length > 0) {
        if (
          providerChoice.finish_reason !== undefined &&
          providerChoice.finish_reason !== null &&
          providerChoice.finish_reason !== 'tool_calls'
        ) {
          throw new ProviderInvalidResponseError(
            'Provider returned an invalid tool finish reason.',
          );
        }
        messages.push({
          role: 'assistant',
          content: choice.content ?? null,
          tool_calls: requestedTools,
        });
        for (const call of requestedTools) {
          toolCalls += 1;
          if (toolCalls > this.options.maxToolCalls) {
            throw new AgentLimitExceededError('Agent tool-call limit was exceeded.');
          }
          if (typeof call.id !== 'string' || !call.id || call.type !== 'function') {
            throw new ProviderInvalidResponseError('Provider tool call is incomplete.');
          }
          const toolName = fromWireToolName(call.function?.name);
          const args = parseToolArguments(toolName, call.function?.arguments);
          const result = await context.toolExecutor.execute(toolName, args, {
            signal: context.signal,
            deadlineAt: startedAt + this.options.timeoutMs,
            maxResultBytes: this.options.maxToolResultBytes,
          });
          if (Buffer.byteLength(JSON.stringify(result)) > this.options.maxToolResultBytes) {
            throw new AgentLimitExceededError('Agent tool-result byte limit was exceeded.');
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
        continue;
      }

      if (typeof choice.content !== 'string' || !choice.content.trim()) {
        throw new ProviderInvalidResponseError('Provider returned neither content nor tool calls.');
      }
      if (providerChoice.finish_reason === 'length') {
        throw new AgentLimitExceededError('Provider output token limit was reached.');
      }
      if (
        providerChoice.finish_reason !== undefined &&
        providerChoice.finish_reason !== null &&
        providerChoice.finish_reason !== 'stop'
      ) {
        throw new ProviderInvalidResponseError('Provider returned an invalid finish reason.');
      }
      return {
        data: parseFinalContent(choice.content) as T,
        tokenUsage,
        tokenUsageRecorded: true,
      };
    }

    throw new AgentLimitExceededError('Agent turn limit was exceeded.');
  }
}

interface OpenAIToolCall {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIResponseBody {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { total_tokens?: number };
}

function validateConfigShape(config: Record<string, unknown>): void {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new RuntimeMisconfiguredError(
        `Unknown OpenAI-compatible runtime configuration field: ${key}`,
      );
    }
  }
  for (const key of ['baseUrl', 'model', 'credentialRef']) {
    if (key in config && readString(config[key]) === undefined) {
      throw new RuntimeMisconfiguredError(`OpenAI-compatible runtime ${key} is invalid.`);
    }
  }
}

function validateBaseUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeMisconfiguredError('OpenAI-compatible baseUrl is invalid.');
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (parsed.username || parsed.password || (parsed.protocol !== 'https:' && !loopback)) {
    throw new RuntimeMisconfiguredError(
      'OpenAI-compatible baseUrl must use HTTPS, or HTTP on loopback, without credentials.',
    );
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoundedInteger(
  config: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = config?.[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RuntimeMisconfiguredError(`OpenAI-compatible runtime ${key} is invalid.`);
  }
  return value as number;
}

function parseProviderResponse(raw: string): OpenAIResponseBody {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as OpenAIResponseBody;
  } catch {
    throw new ProviderInvalidResponseError();
  }
}

function readUsage(value: OpenAIResponseBody['usage']): number {
  const tokens = value?.total_tokens;
  if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens < 0) {
    throw new ProviderInvalidResponseError('Provider response omitted valid token usage.');
  }
  return tokens;
}

function parseToolArguments(name: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    throw new ToolArgumentInvalidError(name, 'Provider tool call is incomplete.');
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ToolArgumentInvalidError(name, 'Provider tool arguments are not valid JSON.');
  }
}

function parseFinalContent(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(outerSignal?.reason);
  if (outerSignal?.aborted) onAbort();
  else outerSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('provider timeout')), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (outerSignal?.aborted) throw outerSignal.reason ?? error;
    if (controller.signal.aborted) throw new ProviderTimeoutError();
    throw new ProviderUnavailableError();
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

const WIRE_TO_TOOL = new Map<string, RepositoryToolName>([
  ['repo_read', 'repo.read'],
  ['repo_search', 'repo.search'],
  ['repo_apply_patch', 'repo.apply_patch'],
  ['repo_diff', 'repo.diff'],
]);

function toWireToolName(name: RepositoryToolName): string {
  return name.replace(/\./g, '_');
}

function fromWireToolName(name: unknown): RepositoryToolName {
  if (typeof name !== 'string') {
    throw new ToolArgumentInvalidError('unknown', 'Provider tool call is incomplete.');
  }
  const mapped = WIRE_TO_TOOL.get(name);
  if (!mapped) throw new ToolArgumentInvalidError(name, 'Provider requested an unknown tool.');
  return mapped;
}

async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProviderTimeoutError()), timeoutMs);
  });
  const cancelled = new Promise<never>((_resolve, reject) => {
    abortListener = () =>
      reject(
        outerSignal?.reason instanceof Error ? outerSignal.reason : new Error('Agent run aborted.'),
      );
    if (outerSignal?.aborted) abortListener();
    else outerSignal?.addEventListener('abort', abortListener, { once: true });
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline, cancelled]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the typed limit error.
        }
        throw new AgentLimitExceededError('Provider response byte limit was exceeded.');
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original typed timeout/cancellation/stream error.
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) outerSignal?.removeEventListener('abort', abortListener);
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Agent run aborted.');
}
