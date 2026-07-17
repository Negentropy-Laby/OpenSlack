import { TextDecoder } from 'node:util';

export type StrictJsonValue =
  | null
  | boolean
  | number
  | string
  | StrictJsonValue[]
  | { [key: string]: StrictJsonValue };

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

  constructor(code: StrictJsonErrorCode, message: string, offset: number) {
    super(message);
    this.name = 'StrictJsonError';
    this.code = code;
    this.offset = offset;
  }
}

class Parser {
  private cursor = 0;
  private nodes = 0;

  constructor(private readonly text: string) {}

  parse(): StrictJsonValue {
    this.skipWhitespace();
    const value = this.parseValue(1);
    this.skipWhitespace();
    if (this.cursor !== this.text.length) this.fail('Unexpected trailing JSON token.');
    return value;
  }

  private parseValue(depth: number): StrictJsonValue {
    if (depth > 64) {
      throw new StrictJsonError(
        'STRICT_JSON_DEPTH_EXCEEDED',
        'JSON nesting depth exceeds 64.',
        this.cursor,
      );
    }
    this.nodes += 1;
    if (this.nodes > 10_000) {
      throw new StrictJsonError(
        'STRICT_JSON_NODE_LIMIT_EXCEEDED',
        'JSON node count exceeds 10000.',
        this.cursor,
      );
    }

    const token = this.text[this.cursor];
    if (token === '{') return this.parseObject(depth);
    if (token === '[') return this.parseArray(depth);
    if (token === '"') return this.parseString();
    if (token === 't') return this.parseLiteral('true', true);
    if (token === 'f') return this.parseLiteral('false', false);
    if (token === 'n') return this.parseLiteral('null', null);
    if (token === '-' || (token !== undefined && token >= '0' && token <= '9')) {
      return this.parseNumber();
    }
    return this.fail('Expected a JSON value.');
  }

  private parseObject(depth: number): { [key: string]: StrictJsonValue } {
    const output: { [key: string]: StrictJsonValue } = Object.create(null) as {
      [key: string]: StrictJsonValue;
    };
    const keys = new Set<string>();
    this.cursor += 1;
    this.skipWhitespace();
    if (this.consume('}')) return output;
    while (true) {
      if (this.text[this.cursor] !== '"') this.fail('Expected a quoted JSON object key.');
      const keyOffset = this.cursor;
      const key = this.parseString();
      if (keys.has(key)) {
        throw new StrictJsonError(
          'STRICT_JSON_DUPLICATE_KEY',
          'JSON object keys must be unique.',
          keyOffset,
        );
      }
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(':')) this.fail('Expected a colon after the JSON object key.');
      this.skipWhitespace();
      Object.defineProperty(output, key, {
        enumerable: true,
        configurable: false,
        writable: false,
        value: this.parseValue(depth + 1),
      });
      this.skipWhitespace();
      if (this.consume('}')) return output;
      if (!this.consume(',')) this.fail('Expected a comma or closing object brace.');
      this.skipWhitespace();
      if (this.text[this.cursor] === '}') this.fail('Trailing commas are not valid JSON.');
    }
  }

  private parseArray(depth: number): StrictJsonValue[] {
    const output: StrictJsonValue[] = [];
    this.cursor += 1;
    this.skipWhitespace();
    if (this.consume(']')) return output;
    while (true) {
      output.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.consume(']')) return output;
      if (!this.consume(',')) this.fail('Expected a comma or closing array bracket.');
      this.skipWhitespace();
      if (this.text[this.cursor] === ']') this.fail('Trailing commas are not valid JSON.');
    }
  }

  private parseString(): string {
    const start = this.cursor;
    this.cursor += 1;
    let escaped = false;
    while (this.cursor < this.text.length) {
      const character = this.text[this.cursor]!;
      if (!escaped && character === '"') {
        this.cursor += 1;
        const raw = this.text.slice(start, this.cursor);
        let value: string;
        try {
          value = JSON.parse(raw) as string;
        } catch {
          return this.fail('Invalid JSON string escape.');
        }
        if (Array.from(value).length > 32_768) {
          throw new StrictJsonError(
            'STRICT_JSON_STRING_LIMIT_EXCEEDED',
            'JSON string exceeds 32768 code points.',
            start,
          );
        }
        return value;
      }
      if (!escaped && character.charCodeAt(0) < 0x20) {
        this.fail('Unescaped control character in JSON string.');
      }
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      }
      this.cursor += 1;
    }
    return this.fail('Unterminated JSON string.');
  }

  private parseNumber(): number {
    const remainder = this.text.slice(this.cursor);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remainder);
    if (!match) return this.fail('Invalid JSON number.');
    const end = this.cursor + match[0].length;
    const next = this.text[end];
    if (
      next !== undefined &&
      next !== ' ' &&
      next !== '\t' &&
      next !== '\r' &&
      next !== '\n' &&
      next !== ',' &&
      next !== '}' &&
      next !== ']'
    ) {
      this.fail('Invalid token after JSON number.');
    }
    this.cursor = end;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      throw new StrictJsonError(
        'STRICT_JSON_NUMBER_NON_FINITE',
        'JSON number must decode to a finite value.',
        this.cursor,
      );
    }
    return value;
  }

  private parseLiteral<T extends boolean | null>(literal: string, value: T): T {
    if (this.text.slice(this.cursor, this.cursor + literal.length) !== literal) {
      return this.fail(`Invalid JSON token; expected ${literal}.`);
    }
    this.cursor += literal.length;
    return value;
  }

  private skipWhitespace(): void {
    while (
      this.text[this.cursor] === ' ' ||
      this.text[this.cursor] === '\t' ||
      this.text[this.cursor] === '\r' ||
      this.text[this.cursor] === '\n'
    ) {
      this.cursor += 1;
    }
  }

  private consume(token: string): boolean {
    if (this.text[this.cursor] !== token) return false;
    this.cursor += 1;
    return true;
  }

  private fail(message: string): never {
    throw new StrictJsonError('STRICT_JSON_SYNTAX_INVALID', message, this.cursor);
  }
}

export function parseStrictJsonBytes(bytes: Buffer): StrictJsonValue {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new StrictJsonError('STRICT_JSON_BOM_FORBIDDEN', 'UTF-8 BOM is forbidden.', 0);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new StrictJsonError('STRICT_JSON_UTF8_INVALID', 'JSON bytes are not valid UTF-8.', 0);
  }
  return new Parser(text).parse();
}
