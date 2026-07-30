import { TextDecoder } from 'node:util';

export type StrictJsonPrimitive = null | boolean | number | string;
export type StrictJsonValue = StrictJsonPrimitive | StrictJsonValue[] | StrictJsonObject;
export interface StrictJsonObject {
  [key: string]: StrictJsonValue;
}

export const STRICT_GRAPH_JSON_ERROR_CODES = Object.freeze([
  'GRAPH_JSON_UTF8_INVALID',
  'GRAPH_JSON_BOM_FORBIDDEN',
  'GRAPH_JSON_SYNTAX_INVALID',
  'GRAPH_JSON_DUPLICATE_KEY',
  'GRAPH_JSON_LIMIT_EXCEEDED',
] as const);

export type StrictGraphJsonErrorCode = (typeof STRICT_GRAPH_JSON_ERROR_CODES)[number];

export class StrictGraphJsonError extends Error {
  readonly code: StrictGraphJsonErrorCode;
  readonly offset: number;

  constructor(code: StrictGraphJsonErrorCode, message: string, offset = 0) {
    super(message);
    this.name = 'StrictGraphJsonError';
    this.code = code;
    this.offset = offset;
  }
}

export interface StrictGraphJsonLimits {
  maxDepth: number;
  maxNodes: number;
  maxStringLength: number;
}

export const STRICT_GRAPH_JSON_DEFAULT_LIMITS: Readonly<StrictGraphJsonLimits> = Object.freeze({
  maxDepth: 64,
  maxNodes: 250_000,
  maxStringLength: 32_768,
});

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

class Parser {
  private cursor = 0;
  private nodes = 0;

  constructor(
    private readonly text: string,
    private readonly limits: StrictGraphJsonLimits,
  ) {}

  parse(): StrictJsonValue {
    this.skipWhitespace();
    const value = this.value(1);
    this.skipWhitespace();
    if (this.cursor !== this.text.length) this.syntax('Unexpected trailing JSON token.');
    return value;
  }

  private value(depth: number): StrictJsonValue {
    if (depth > this.limits.maxDepth) this.limit('JSON nesting depth exceeds its limit.');
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) this.limit('JSON node count exceeds its limit.');
    const token = this.text[this.cursor];
    if (token === '"') return this.string();
    if (token === '{') return this.object(depth);
    if (token === '[') return this.array(depth);
    if (token === 't') return this.literal('true', true);
    if (token === 'f') return this.literal('false', false);
    if (token === 'n') return this.literal('null', null);
    if (token === '-' || (token !== undefined && token >= '0' && token <= '9')) {
      return this.number();
    }
    return this.syntax('Expected a JSON value.');
  }

  private object(depth: number): StrictJsonObject {
    const result = Object.create(null) as StrictJsonObject;
    const keys = new Set<string>();
    this.cursor += 1;
    this.skipWhitespace();
    if (this.consume('}')) return result;
    while (true) {
      if (this.text[this.cursor] !== '"') this.syntax('Expected a quoted JSON object key.');
      const offset = this.cursor;
      const key = this.string();
      if (keys.has(key)) {
        throw new StrictGraphJsonError(
          'GRAPH_JSON_DUPLICATE_KEY',
          `Duplicate JSON object key ${JSON.stringify(key)}.`,
          offset,
        );
      }
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(':')) this.syntax('Expected a colon after the JSON object key.');
      this.skipWhitespace();
      Object.defineProperty(result, key, {
        value: this.value(depth + 1),
        enumerable: true,
        writable: false,
        configurable: false,
      });
      this.skipWhitespace();
      if (this.consume('}')) return result;
      if (!this.consume(',')) this.syntax('Expected a comma or closing object brace.');
      this.skipWhitespace();
      if (this.text[this.cursor] === '}') this.syntax('Trailing commas are not valid JSON.');
    }
  }

  private array(depth: number): StrictJsonValue[] {
    const result: StrictJsonValue[] = [];
    this.cursor += 1;
    this.skipWhitespace();
    if (this.consume(']')) return result;
    while (true) {
      result.push(this.value(depth + 1));
      this.skipWhitespace();
      if (this.consume(']')) return result;
      if (!this.consume(',')) this.syntax('Expected a comma or closing array bracket.');
      this.skipWhitespace();
      if (this.text[this.cursor] === ']') this.syntax('Trailing commas are not valid JSON.');
    }
  }

  private string(): string {
    const start = this.cursor;
    this.cursor += 1;
    let result = '';
    while (this.cursor < this.text.length) {
      const character = this.text[this.cursor]!;
      this.cursor += 1;
      if (character === '"') return this.checkedString(result, start);
      if (character === '\\') {
        result += this.escape();
      } else {
        if (character.charCodeAt(0) <= 0x1f) this.syntax('Unescaped control character.');
        result += character;
      }
      if (result.length > this.limits.maxStringLength) this.limit('JSON string exceeds its limit.');
    }
    return this.syntax('Unterminated JSON string.');
  }

  private checkedString(value: string, offset: number): string {
    if (value.length > this.limits.maxStringLength) {
      throw new StrictGraphJsonError(
        'GRAPH_JSON_LIMIT_EXCEEDED',
        'JSON string exceeds its limit.',
        offset,
      );
    }
    if (hasUnpairedSurrogate(value)) {
      throw new StrictGraphJsonError(
        'GRAPH_JSON_SYNTAX_INVALID',
        'JSON string contains an unpaired Unicode surrogate.',
        offset,
      );
    }
    return value;
  }

  private escape(): string {
    const escaped = this.text[this.cursor];
    this.cursor += 1;
    if (escaped === '"' || escaped === '\\' || escaped === '/') return escaped;
    if (escaped === 'b') return '\b';
    if (escaped === 'f') return '\f';
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 't') return '\t';
    if (escaped === 'u') {
      const digits = this.text.slice(this.cursor, this.cursor + 4);
      if (!/^[0-9a-f]{4}$/i.test(digits)) this.syntax('Invalid Unicode escape.');
      this.cursor += 4;
      return String.fromCharCode(Number.parseInt(digits, 16));
    }
    return this.syntax('Invalid escape sequence.');
  }

  private number(): number {
    const rest = this.text.slice(this.cursor);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (!match) return this.syntax('Invalid JSON number.');
    const lexeme = match[0];
    const next = rest[lexeme.length];
    if (next !== undefined && !/[\u0009\u000a\u000d\u0020,}\]]/.test(next)) {
      return this.syntax('Invalid token after JSON number.');
    }
    this.cursor += lexeme.length;
    const value = Number(lexeme);
    if (!Number.isFinite(value)) return this.syntax('JSON number is not finite.');
    return value;
  }

  private literal<T extends StrictJsonPrimitive>(lexeme: string, value: T): T {
    if (this.text.slice(this.cursor, this.cursor + lexeme.length) !== lexeme) {
      return this.syntax(`Invalid JSON token; expected ${lexeme}.`);
    }
    this.cursor += lexeme.length;
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

  private syntax(message: string): never {
    throw new StrictGraphJsonError('GRAPH_JSON_SYNTAX_INVALID', message, this.cursor);
  }

  private limit(message: string): never {
    throw new StrictGraphJsonError('GRAPH_JSON_LIMIT_EXCEEDED', message, this.cursor);
  }
}

export function parseStrictGraphJson(
  bytes: Buffer,
  limits: Partial<StrictGraphJsonLimits> = {},
): StrictJsonValue {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new StrictGraphJsonError('GRAPH_JSON_BOM_FORBIDDEN', 'UTF-8 BOM is forbidden.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new StrictGraphJsonError(
      'GRAPH_JSON_UTF8_INVALID',
      'Graph JSON bytes are not valid UTF-8.',
    );
  }
  return new Parser(text, { ...STRICT_GRAPH_JSON_DEFAULT_LIMITS, ...limits }).parse();
}
