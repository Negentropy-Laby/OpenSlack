import { TextDecoder, types as nodeTypes } from 'node:util';

export type WorkflowEffectJsonPrimitive = null | boolean | number | string;
export type WorkflowEffectJsonValue =
  | WorkflowEffectJsonPrimitive
  | WorkflowEffectJsonValue[]
  | WorkflowEffectJsonObject;
export interface WorkflowEffectJsonObject {
  [key: string]: WorkflowEffectJsonValue;
}

export class WorkflowEffectJsonError extends Error {
  readonly code:
    | 'WORKFLOW_EFFECT_JSON_INVALID'
    | 'WORKFLOW_EFFECT_JSON_DUPLICATE_KEY'
    | 'WORKFLOW_EFFECT_JSON_LIMIT_EXCEEDED';
  readonly offset: number;

  constructor(code: WorkflowEffectJsonError['code'], message: string, offset = 0) {
    super(message);
    this.name = 'WorkflowEffectJsonError';
    this.code = code;
    this.offset = offset;
  }
}

export interface WorkflowEffectJsonLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxStringLength: number;
  /** Optional UTF-8 byte ceiling applied to both object keys and string values. */
  readonly maxStringBytes?: number;
  /** Reject isolated UTF-16 surrogate code units after JSON escape decoding. */
  readonly unicodeScalarsOnly?: boolean;
  /** Accept only the exact decimal spelling of a JavaScript safe integer. */
  readonly canonicalSafeIntegersOnly?: boolean;
}

interface ResolvedLimits extends WorkflowEffectJsonLimits {
  readonly maxStringBytes: number;
  readonly unicodeScalarsOnly: boolean;
  readonly canonicalSafeIntegersOnly: boolean;
}

class StrictParser {
  #cursor = 0;
  #nodes = 0;

  constructor(
    private readonly text: string,
    private readonly limits: ResolvedLimits,
  ) {}

  parse(): WorkflowEffectJsonValue {
    this.skipWhitespace();
    const value = this.value(1);
    this.skipWhitespace();
    if (this.#cursor !== this.text.length) this.invalid('Unexpected trailing JSON token.');
    return value;
  }

  private value(depth: number): WorkflowEffectJsonValue {
    if (depth > this.limits.maxDepth) this.limit('JSON nesting depth exceeds its limit.');
    this.#nodes += 1;
    if (this.#nodes > this.limits.maxNodes) this.limit('JSON node count exceeds its limit.');
    const token = this.text[this.#cursor];
    if (token === '"') return this.string();
    if (token === '{') return this.object(depth);
    if (token === '[') return this.array(depth);
    if (token === 't') return this.literal('true', true);
    if (token === 'f') return this.literal('false', false);
    if (token === 'n') return this.literal('null', null);
    if (token === '-' || (token !== undefined && token >= '0' && token <= '9')) {
      return this.number();
    }
    return this.invalid('Expected a JSON value.');
  }

  private object(depth: number): WorkflowEffectJsonObject {
    const result = Object.create(null) as WorkflowEffectJsonObject;
    const keys = new Set<string>();
    this.#cursor += 1;
    this.skipWhitespace();
    if (this.consume('}')) return result;
    while (true) {
      if (this.text[this.#cursor] !== '"') this.invalid('Expected a quoted object key.');
      const offset = this.#cursor;
      const key = this.string();
      if (keys.has(key)) {
        throw new WorkflowEffectJsonError(
          'WORKFLOW_EFFECT_JSON_DUPLICATE_KEY',
          `Duplicate JSON object key ${JSON.stringify(key)}.`,
          offset,
        );
      }
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(':')) this.invalid('Expected a colon after an object key.');
      this.skipWhitespace();
      Object.defineProperty(result, key, {
        value: this.value(depth + 1),
        enumerable: true,
        writable: false,
        configurable: false,
      });
      this.skipWhitespace();
      if (this.consume('}')) return result;
      if (!this.consume(',')) this.invalid('Expected a comma or closing object brace.');
      this.skipWhitespace();
      if (this.text[this.#cursor] === '}') this.invalid('Trailing commas are invalid.');
    }
  }

  private array(depth: number): WorkflowEffectJsonValue[] {
    const result: WorkflowEffectJsonValue[] = [];
    this.#cursor += 1;
    this.skipWhitespace();
    if (this.consume(']')) return result;
    while (true) {
      result.push(this.value(depth + 1));
      this.skipWhitespace();
      if (this.consume(']')) return result;
      if (!this.consume(',')) this.invalid('Expected a comma or closing array bracket.');
      this.skipWhitespace();
      if (this.text[this.#cursor] === ']') this.invalid('Trailing commas are invalid.');
    }
  }

  private string(): string {
    const start = this.#cursor;
    this.#cursor += 1;
    let result = '';
    while (this.#cursor < this.text.length) {
      const character = this.text[this.#cursor]!;
      this.#cursor += 1;
      if (character === '"') return this.checkedString(result, start);
      if (character === '\\') {
        result += this.escape();
      } else {
        if (character.charCodeAt(0) <= 0x1f) this.invalid('Unescaped control character.');
        result += character;
      }
      if (result.length > this.limits.maxStringLength) this.limit('JSON string is too long.');
    }
    return this.invalid('Unterminated JSON string.');
  }

  private checkedString(value: string, offset: number): string {
    if (value.length > this.limits.maxStringLength) {
      throw new WorkflowEffectJsonError(
        'WORKFLOW_EFFECT_JSON_LIMIT_EXCEEDED',
        'JSON string is too long.',
        offset,
      );
    }
    if (this.limits.unicodeScalarsOnly && containsUnpairedSurrogate(value)) {
      throw new WorkflowEffectJsonError(
        'WORKFLOW_EFFECT_JSON_INVALID',
        'JSON string contains an unpaired Unicode surrogate.',
        offset,
      );
    }
    if (Buffer.byteLength(value, 'utf8') > this.limits.maxStringBytes) {
      throw new WorkflowEffectJsonError(
        'WORKFLOW_EFFECT_JSON_LIMIT_EXCEEDED',
        'JSON string exceeds its byte limit.',
        offset,
      );
    }
    return value;
  }

  private escape(): string {
    const escaped = this.text[this.#cursor];
    this.#cursor += 1;
    if (escaped === '"' || escaped === '\\' || escaped === '/') return escaped;
    if (escaped === 'b') return '\b';
    if (escaped === 'f') return '\f';
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 't') return '\t';
    if (escaped === 'u') {
      const digits = this.text.slice(this.#cursor, this.#cursor + 4);
      if (!/^[0-9a-f]{4}$/i.test(digits)) this.invalid('Invalid Unicode escape.');
      this.#cursor += 4;
      return String.fromCharCode(Number.parseInt(digits, 16));
    }
    return this.invalid('Invalid escape sequence.');
  }

  private number(): number {
    const rest = this.text.slice(this.#cursor);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (!match) return this.invalid('Invalid JSON number.');
    const lexeme = match[0];
    const next = rest[lexeme.length];
    if (next !== undefined && !/[\u0009\u000a\u000d\u0020,}\]]/.test(next)) {
      return this.invalid('Invalid token after JSON number.');
    }
    this.#cursor += lexeme.length;
    const value = Number(lexeme);
    if (!Number.isFinite(value)) return this.invalid('JSON number is not finite.');
    if (
      this.limits.canonicalSafeIntegersOnly &&
      (!Number.isSafeInteger(value) || String(value) !== lexeme)
    ) {
      return this.invalid('JSON number must be a canonical safe integer.');
    }
    return value;
  }

  private literal<T extends WorkflowEffectJsonPrimitive>(lexeme: string, value: T): T {
    if (this.text.slice(this.#cursor, this.#cursor + lexeme.length) !== lexeme) {
      return this.invalid(`Invalid JSON token; expected ${lexeme}.`);
    }
    this.#cursor += lexeme.length;
    return value;
  }

  private consume(character: string): boolean {
    if (this.text[this.#cursor] !== character) return false;
    this.#cursor += 1;
    return true;
  }

  private skipWhitespace(): void {
    while (/^[\u0009\u000a\u000d\u0020]$/.test(this.text[this.#cursor] ?? '')) {
      this.#cursor += 1;
    }
  }

  private invalid(message: string): never {
    throw new WorkflowEffectJsonError('WORKFLOW_EFFECT_JSON_INVALID', message, this.#cursor);
  }

  private limit(message: string): never {
    throw new WorkflowEffectJsonError('WORKFLOW_EFFECT_JSON_LIMIT_EXCEEDED', message, this.#cursor);
  }
}

export function parseWorkflowEffectJson(
  bytes: Buffer,
  limits: Partial<WorkflowEffectJsonLimits> = {},
): WorkflowEffectJsonValue {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new WorkflowEffectJsonError('WORKFLOW_EFFECT_JSON_INVALID', 'UTF-8 BOM is forbidden.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new WorkflowEffectJsonError(
      'WORKFLOW_EFFECT_JSON_INVALID',
      'Workflow effect JSON is not valid UTF-8.',
    );
  }
  return new StrictParser(text, {
    maxDepth: limits.maxDepth ?? 8,
    maxNodes: limits.maxNodes ?? 128,
    maxStringLength: limits.maxStringLength ?? 2_048,
    maxStringBytes: limits.maxStringBytes ?? Number.MAX_SAFE_INTEGER,
    unicodeScalarsOnly: limits.unicodeScalarsOnly ?? false,
    canonicalSafeIntegersOnly: limits.canonicalSafeIntegersOnly ?? false,
  }).parse();
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function canonicalWorkflowEffectJson(value: unknown): string {
  return encode(value);

  function encode(item: unknown): string {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') {
      return JSON.stringify(item);
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Canonical JSON rejects non-finite values.');
      return JSON.stringify(item);
    }
    if (nodeTypes.isProxy(item)) throw new TypeError('Canonical JSON rejects Proxy values.');
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    if (
      typeof item !== 'object' ||
      item === null ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(item) as never)
    ) {
      throw new TypeError('Canonical JSON requires inert data.');
    }
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== 'string')) {
      throw new TypeError('Canonical JSON rejects symbol keys.');
    }
    return `{${(keys as string[])
      .sort()
      .map((key) => {
        if (FORBIDDEN_KEYS.has(key)) throw new TypeError('Canonical JSON rejects unsafe keys.');
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('Canonical JSON rejects accessors.');
        }
        if (descriptor.value === undefined)
          throw new TypeError('Canonical JSON rejects undefined.');
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
      })
      .join(',')}}`;
  }
}
