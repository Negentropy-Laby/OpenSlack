import {
  OPENSLACK_READ_TOOL_CATALOG,
  OPENSLACK_READ_TOOL_NAMES,
  ToolInputValidationError,
  createOpenSlackMcpResult,
  getOpenSlackReadToolDefinition,
  isOpenSlackReadToolName,
  validateToolInput,
  type OpenSlackMcpResult,
  type OpenSlackReadToolDefinition,
} from '@openslack/qoder-adapter';
import type { OpenSlackMcpContext } from './context.js';
import { OpenSlackMcpProtocolError, safeToolError } from './errors.js';
import { projectToolData } from './projections.js';
import {
  normalizeTypedEvidenceReference,
  normalizeTypedEvidenceReferences,
  redactProtocolString,
} from './sanitizer.js';
import { OPENSLACK_READ_TOOL_HANDLERS } from './tools/index.js';
import { evidenceFrom, normalizeEvidenceReferences } from './tools/shared.js';

export interface OpenSlackMcpContent {
  readonly type: 'text';
  readonly text: string;
}

export interface OpenSlackMcpToolCallResult {
  readonly content: readonly OpenSlackMcpContent[];
  readonly structuredContent: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
}

export interface OpenSlackMcpCoreOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MIN_MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 4_000;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 200;
const SENSITIVE_NORMALIZED_KEYS = new Set([
  'apikey',
  'accesskey',
  'accesskeyid',
  'secret',
  'secretkey',
  'secretaccesskey',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'npmtoken',
  'password',
  'passwd',
  'authorization',
  'proxyauthorization',
  'auth',
  'cookie',
  'setcookie',
  'session',
  'sessionid',
  'privatekey',
  'jwt',
]);
function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    SENSITIVE_NORMALIZED_KEYS.has(normalized) ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('clientsecret') ||
    normalized.endsWith('password') ||
    normalized.endsWith('token') ||
    normalized.endsWith('cookie') ||
    normalized.endsWith('sessionid')
  );
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return resolved;
}

function redactString(value: string): string {
  return redactProtocolString(value, MAX_TEXT_LENGTH);
}

function sanitizeForProtocol(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[MAX_DEPTH]';
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeForProtocol(entry, depth + 1));
  }
  if (typeof value !== 'object') return String(value);
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(
    0,
    MAX_OBJECT_KEYS,
  )) {
    if (key === 'evidenceRef') {
      if (typeof child === 'string') {
        const reference = normalizeTypedEvidenceReference(child);
        if (reference) output[key] = reference;
      }
      continue;
    }
    if (key === 'evidenceRefs') {
      output[key] = Array.isArray(child) ? normalizeTypedEvidenceReferences(child) : [];
      continue;
    }
    output[key] = isSensitiveKey(key) ? '[REDACTED]' : sanitizeForProtocol(child, depth + 1);
  }
  return output;
}

function failedResult(code: string, message: string): OpenSlackMcpResult {
  return createOpenSlackMcpResult({
    status: 'failed',
    summary: message,
    error: { code, message },
    governance: { blocker: code },
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error('READ_PROJECTION_TIMEOUT'));
          reject(new Error('READ_PROJECTION_TIMEOUT'));
        }, timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertFrozenCatalog(): void {
  if (
    OPENSLACK_READ_TOOL_CATALOG.length !== 9 ||
    OPENSLACK_READ_TOOL_NAMES.length !== 9 ||
    !Object.isFrozen(OPENSLACK_READ_TOOL_CATALOG)
  ) {
    throw new Error('READ_TOOL_CATALOG_INVALID');
  }
  const catalogNames = OPENSLACK_READ_TOOL_CATALOG.map((tool) => tool.name);
  if (
    new Set(catalogNames).size !== 9 ||
    OPENSLACK_READ_TOOL_NAMES.some((name) => !catalogNames.includes(name)) ||
    OPENSLACK_READ_TOOL_NAMES.some((name) => !(name in OPENSLACK_READ_TOOL_HANDLERS))
  ) {
    throw new Error('READ_TOOL_CATALOG_DRIFT');
  }
}

export class OpenSlackMcpCore {
  readonly #context: OpenSlackMcpContext;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(context: OpenSlackMcpContext, options: OpenSlackMcpCoreOptions = {}) {
    assertFrozenCatalog();
    this.#context = context;
    this.#timeoutMs = boundedInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      'timeoutMs',
    );
    this.#maxOutputBytes = boundedInteger(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      MIN_MAX_OUTPUT_BYTES,
      MAX_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
    );
  }

  listTools(): readonly OpenSlackReadToolDefinition[] {
    return OPENSLACK_READ_TOOL_CATALOG;
  }

  async callTool(name: string, args: unknown = {}): Promise<OpenSlackMcpToolCallResult> {
    if (!isOpenSlackReadToolName(name)) {
      throw new OpenSlackMcpProtocolError(-32602, `Unknown tool: ${name}`);
    }
    const definition = getOpenSlackReadToolDefinition(name);
    if (!definition) throw new OpenSlackMcpProtocolError(-32602, `Unknown tool: ${name}`);

    let input: Readonly<Record<string, unknown>>;
    try {
      input = validateToolInput(definition, args);
    } catch (error) {
      if (error instanceof ToolInputValidationError) {
        throw new OpenSlackMcpProtocolError(-32602, error.message);
      }
      throw error;
    }

    let result: OpenSlackMcpResult;
    try {
      const controller = new AbortController();
      result = await withTimeout(
        OPENSLACK_READ_TOOL_HANDLERS[name](this.#context, input, controller.signal),
        this.#timeoutMs,
        controller,
      );
    } catch (error) {
      const safe = safeToolError(error);
      result = failedResult(safe.safeCode, safe.safeMessage);
    }

    const projectedData =
      result.data === undefined ? undefined : projectToolData(name, result.data);
    result = createOpenSlackMcpResult({
      status: result.status,
      summary: result.summary,
      ...(projectedData === undefined ? {} : { data: projectedData }),
      governance: result.governance,
      nextActions: [],
      evidenceRefs: normalizeEvidenceReferences([
        ...result.evidenceRefs,
        ...evidenceFrom(projectedData),
      ]),
      ...(result.planId ? { planId: result.planId } : {}),
      ...(result.executionId ? { executionId: result.executionId } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    const structured = sanitizeForProtocol(result) as Readonly<Record<string, unknown>>;
    let serialized = JSON.stringify(structured);
    if (Buffer.byteLength(serialized, 'utf8') > this.#maxOutputBytes) {
      const bounded = sanitizeForProtocol(
        failedResult(
          'READ_PROJECTION_TOO_LARGE',
          'The requested OpenSlack projection exceeded the protocol output bound.',
        ),
      ) as Readonly<Record<string, unknown>>;
      serialized = JSON.stringify(bounded);
      return Object.freeze({
        content: Object.freeze([{ type: 'text' as const, text: serialized }]),
        structuredContent: Object.freeze(bounded),
        isError: true,
      });
    }

    return Object.freeze({
      content: Object.freeze([{ type: 'text' as const, text: serialized }]),
      structuredContent: Object.freeze(structured),
      isError: result.status === 'failed',
    });
  }
}
