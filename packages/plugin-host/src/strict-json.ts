import { TextDecoder } from 'node:util';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export type JsonArray = JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export const STRICT_JSON_MAX_DEPTH = 64;
export const STRICT_JSON_MAX_NODES = 10_000;
export const STRICT_JSON_MAX_STRING_LENGTH = 32_768;

export interface StrictJsonLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxStringLength: number;
}

export const STRICT_JSON_ERROR_CODES = Object.freeze([
  'STRICT_JSON_UTF8_INVALID',
  'STRICT_JSON_BOM_FORBIDDEN',
  'STRICT_JSON_SYNTAX_INVALID',
  'STRICT_JSON_DUPLICATE_KEY',
  'STRICT_JSON_NUMBER_NON_FINITE',
  'STRICT_JSON_DEPTH_EXCEEDED',
  'STRICT_JSON_NODE_LIMIT_EXCEEDED',
  'STRICT_JSON_STRING_LIMIT_EXCEEDED',
] as const);

export type StrictJsonErrorCode = (typeof STRICT_JSON_ERROR_CODES)[number];

export class StrictJsonError extends Error {
  readonly code: StrictJsonErrorCode;
  readonly offset: number;

  constructor(code: StrictJsonErrorCode, message: string, offset = 0) {
    super(message);
    this.name = 'StrictJsonError';
    this.code = code;
    this.offset = offset;
  }
}

function clampPositiveInteger(value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1) return 1;
  return Math.min(value, ceiling);
}

export function resolveStrictJsonLimits(limits: Partial<StrictJsonLimits> = {}): StrictJsonLimits {
  return Object.freeze({
    maxDepth: clampPositiveInteger(limits.maxDepth, STRICT_JSON_MAX_DEPTH),
    maxNodes: clampPositiveInteger(limits.maxNodes, STRICT_JSON_MAX_NODES),
    maxStringLength: clampPositiveInteger(limits.maxStringLength, STRICT_JSON_MAX_STRING_LENGTH),
  });
}

class StrictJsonParser {
  private readonly text: string;
  private readonly limits: StrictJsonLimits;
  private cursor = 0;
  private nodes = 0;

  constructor(text: string, limits: StrictJsonLimits) {
    this.text = text;
    this.limits = limits;
  }

  parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue(1);
    this.skipWhitespace();
    if (this.cursor !== this.text.length) {
      this.fail('STRICT_JSON_SYNTAX_INVALID', 'Unexpected trailing JSON token.');
    }
    return value;
  }

  private parseValue(depth: number): JsonValue {
    if (depth > this.limits.maxDepth) {
      this.fail('STRICT_JSON_DEPTH_EXCEEDED', 'JSON nesting depth exceeds the configured limit.');
    }
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) {
      this.fail('STRICT_JSON_NODE_LIMIT_EXCEEDED', 'JSON node count exceeds the configured limit.');
    }

    const token = this.text[this.cursor];
    if (token === '"') return this.parseString();
    if (token === '{') return this.parseObject(depth);
    if (token === '[') return this.parseArray(depth);
    if (token === 't') return this.parseLiteral('true', true);
    if (token === 'f') return this.parseLiteral('false', false);
    if (token === 'n') return this.parseLiteral('null', null);
    if (token === '-' || (token !== undefined && token >= '0' && token <= '9')) {
      return this.parseNumber();
    }
    this.fail('STRICT_JSON_SYNTAX_INVALID', 'Expected a JSON value.');
  }

  private parseObject(depth: number): JsonObject {
    const object = Object.create(null) as JsonObject;
    const keys = new Set<string>();
    this.cursor += 1;
    this.skipWhitespace();
    if (this.consume('}')) return object;

    while (true) {
      if (this.text[this.cursor] !== '"') {
        this.fail('STRICT_JSON_SYNTAX_INVALID', 'Expected a quoted JSON object key.');
      }
      const keyOffset = this.cursor;
      const key = this.parseString();
      if (keys.has(key)) {
        throw new StrictJsonError(
          'STRICT_JSON_DUPLICATE_KEY',
          `Duplicate JSON object key ${JSON.stringify(key)}.`,
          keyOffset,
        );
      }
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(':')) {
        this.fail('STRICT_JSON_SYNTAX_INVALID', 'Expected a colon after the JSON object key.');
      }
      this.skipWhitespace();
      Object.defineProperty(object, key, {
        value: this.parseValue(depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
      this.skipWhitespace();
      if (this.consume('}')) return object;
      if (!this.consume(',')) {
        this.fail('STRICT_JSON_SYNTAX_INVALID', 'Expected a comma or closing object brace.');
      }
      this.skipWhitespace();
      if (this.text[this.cursor] === '}') {
        this.fail('STRICT_JSON_SYNTAX_INVALID', 'Trailing commas are not valid JSON.');
      }
    }
  }

  private parseArray(depth: number): JsonArray {
    const array: JsonArray = [];
    this.cursor += 1;
    this.skipWhitespace();
    if (this.consume(']')) return array;

    while (true) {
      array.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.consume(']')) return array;
      if (!this.consume(',')) {
        this.fail('STRICT_JSON_SYNTAX_INVALID', 'Expected a comma or closing array bracket.');
      }
      this.skipWhitespace();
      if (this.text[this.cursor] === ']') {
        this.fail('STRICT_JSON_SYNTAX_INVALID', 'Trailing commas are not valid JSON.');
      }
    }
  }

  private parseString(): string {
    const start = this.cursor;
    this.cursor += 1;
    let value = '';

    while (this.cursor < this.text.length) {
      const character = this.text[this.cursor]!;
      this.cursor += 1;
      if (character === '"') {
        if (value.length > this.limits.maxStringLength) {
          throw new StrictJsonError(
            'STRICT_JSON_STRING_LIMIT_EXCEEDED',
            'Decoded JSON string exceeds the configured limit.',
            start,
          );
        }
        return value;
      }
      if (character === '\\') {
        value += this.parseEscape();
      } else {
        if (character.charCodeAt(0) <= 0x1f) {
          this.fail('STRICT_JSON_SYNTAX_INVALID', 'Unescaped control character in JSON string.');
        }
        value += character;
      }
      if (value.length > this.limits.maxStringLength) {
        throw new StrictJsonError(
          'STRICT_JSON_STRING_LIMIT_EXCEEDED',
          'Decoded JSON string exceeds the configured limit.',
          start,
        );
      }
    }
    throw new StrictJsonError('STRICT_JSON_SYNTAX_INVALID', 'Unterminated JSON string.', start);
  }

  private parseEscape(): string {
    const escaped = this.text[this.cursor];
    this.cursor += 1;
    switch (escaped) {
      case '"':
      case '\\':
      case '/':
        return escaped;
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u': {
        const digits = this.text.slice(this.cursor, this.cursor + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(digits)) {
          this.fail('STRICT_JSON_SYNTAX_INVALID', 'Invalid Unicode escape in JSON string.');
        }
        this.cursor += 4;
        return String.fromCharCode(Number.parseInt(digits, 16));
      }
      default:
        this.fail('STRICT_JSON_SYNTAX_INVALID', 'Invalid escape sequence in JSON string.');
    }
  }

  private parseNumber(): number {
    const rest = this.text.slice(this.cursor);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (!match) this.fail('STRICT_JSON_SYNTAX_INVALID', 'Invalid JSON number.');
    const lexeme = match[0];
    const next = rest[lexeme.length];
    if (next !== undefined && !/[\u0009\u000a\u000d\u0020,}\]]/.test(next)) {
      this.fail('STRICT_JSON_SYNTAX_INVALID', 'Invalid token after JSON number.');
    }
    this.cursor += lexeme.length;
    const value = Number(lexeme);
    if (!Number.isFinite(value)) {
      this.fail('STRICT_JSON_NUMBER_NON_FINITE', 'JSON number must decode to a finite value.');
    }
    return value;
  }

  private parseLiteral<T extends JsonPrimitive>(literal: string, value: T): T {
    if (this.text.slice(this.cursor, this.cursor + literal.length) !== literal) {
      this.fail('STRICT_JSON_SYNTAX_INVALID', `Invalid JSON token; expected ${literal}.`);
    }
    this.cursor += literal.length;
    return value;
  }

  private consume(character: string): boolean {
    if (this.text[this.cursor] !== character) return false;
    this.cursor += 1;
    return true;
  }

  private skipWhitespace(): void {
    while (/^[\u0009\u000a\u000d\u0020]$/.test(this.text[this.cursor] ?? '')) {
      this.cursor += 1;
    }
  }

  private fail(code: StrictJsonErrorCode, message: string): never {
    throw new StrictJsonError(code, message, this.cursor);
  }
}

export function parseStrictJsonBytes(
  bytes: Buffer,
  limits: Partial<StrictJsonLimits> = {},
): JsonValue {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new StrictJsonError(
      'STRICT_JSON_BOM_FORBIDDEN',
      'UTF-8 BOM is forbidden in strict JSON.',
    );
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new StrictJsonError('STRICT_JSON_UTF8_INVALID', 'JSON bytes are not valid UTF-8.');
  }

  return new StrictJsonParser(text, resolveStrictJsonLimits(limits)).parse();
}
