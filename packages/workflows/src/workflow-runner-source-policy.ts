const MAX_POLICY_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_POLICY_TOKENS = 131_072;
const MAX_TEMPLATE_NESTING = 128;

type TokenKind = 'identifier' | 'literal' | 'punctuator';

interface SourceToken {
  readonly kind: TokenKind;
  readonly value: string;
  readonly offset: number;
}

const IDENTIFIER_START = /^[$_\p{ID_Start}]$/u;
const IDENTIFIER_PART = /^[$_\u200C\u200D\p{ID_Continue}]$/u;
const CONTROL_PAREN_KEYWORDS = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);
const DYNAMIC_SOURCE_EVALUATORS = new Set([
  'AsyncFunction',
  'AsyncGeneratorFunction',
  'Function',
  'GeneratorFunction',
  'eval',
]);
const REGEX_PREFIX_IDENTIFIERS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);
const REGEX_PREFIX_PUNCTUATORS = new Set([
  '!',
  '!=',
  '!==',
  '%',
  '%=',
  '&',
  '&&',
  '&&=',
  '&=',
  '(',
  '*',
  '**',
  '**=',
  '*=',
  '+',
  '+=',
  ',',
  '-',
  '-=',
  ':',
  ';',
  '<',
  '<<',
  '<<=',
  '<=',
  '=',
  '==',
  '===',
  '=>',
  '>',
  '>=',
  '>>',
  '>>=',
  '>>>',
  '>>>=',
  '?',
  '??',
  '??=',
  '[',
  '^',
  '^=',
  'control-)',
  '{',
  '|',
  '|=',
  '||',
  '||=',
  '~',
]);
const PUNCTUATORS = [
  '>>>=',
  '**=',
  '&&=',
  '===',
  '!==',
  '<<=',
  '>>=',
  '>>>',
  '??=',
  '||=',
  '=>',
  '**',
  '&&',
  '==',
  '!=',
  '<=',
  '<<',
  '>=',
  '>>',
  '??',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '?.',
] as const;

export class WorkflowRunnerSourcePolicyError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (source offset ${offset})`);
    this.name = 'WorkflowRunnerSourcePolicyError';
    this.offset = offset;
  }
}

class BoundedJavaScriptLexer {
  readonly #source: string;
  readonly #tokens: SourceToken[] = [];
  #index = 0;

  constructor(source: string) {
    this.#source = source;
  }

  scan(): readonly SourceToken[] {
    if (this.#source.startsWith('#!')) this.#skipLineComment();
    this.#scanCode(false, 0);
    return Object.freeze(this.#tokens.slice());
  }

  #scanCode(endAtTemplateBrace: boolean, templateDepth: number): void {
    let braceDepth = 0;
    const parenKinds: boolean[] = [];
    let previous: SourceToken | undefined;

    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index]!;
      if (/\s/u.test(character)) {
        this.#index += 1;
        continue;
      }
      if (character === '/' && this.#source[this.#index + 1] === '/') {
        this.#skipLineComment();
        continue;
      }
      if (character === '/' && this.#source[this.#index + 1] === '*') {
        this.#skipBlockComment();
        continue;
      }
      if (character === "'" || character === '"') {
        const token = this.#scanQuotedString(character);
        this.#push(token);
        previous = token;
        continue;
      }
      if (character === '`') {
        const token = this.#scanTemplate(templateDepth);
        this.#push(token);
        previous = token;
        continue;
      }
      if (character === '/' && this.#canStartRegex(previous)) {
        const token = this.#scanRegex();
        this.#push(token);
        previous = token;
        continue;
      }
      if (this.#isIdentifierStart()) {
        const token = this.#scanIdentifier();
        this.#push(token);
        previous = token;
        continue;
      }
      if (/[0-9]/u.test(character)) {
        const token = this.#scanNumber();
        this.#push(token);
        previous = token;
        continue;
      }
      if (endAtTemplateBrace && character === '}' && braceDepth === 0) {
        this.#index += 1;
        return;
      }

      const token = this.#scanPunctuator();
      if (token.value === '{') braceDepth += 1;
      if (token.value === '}') braceDepth = Math.max(0, braceDepth - 1);
      if (token.value === '(') {
        parenKinds.push(
          previous?.kind === 'identifier' && CONTROL_PAREN_KEYWORDS.has(previous.value),
        );
      } else if (token.value === ')') {
        const isControl = parenKinds.pop() ?? false;
        if (isControl) {
          const controlToken = { ...token, value: 'control-)' } as const;
          this.#push(controlToken);
          previous = controlToken;
          continue;
        }
      }
      this.#push(token);
      previous = token;
    }

    if (endAtTemplateBrace) {
      throw this.#error('Unterminated template expression');
    }
  }

  #push(token: SourceToken): void {
    if (this.#tokens.length >= MAX_POLICY_TOKENS) {
      throw this.#error('Workflow source exceeds the policy token limit', token.offset);
    }
    this.#tokens.push(Object.freeze(token));
  }

  #skipLineComment(): void {
    const start = this.#index;
    if (this.#source.startsWith('#!', this.#index)) this.#index += 2;
    else this.#index += 2;
    while (
      this.#index < this.#source.length &&
      !/[\r\n\u2028\u2029]/u.test(this.#source[this.#index]!)
    ) {
      this.#index += 1;
    }
    if (this.#index < start) throw this.#error('Invalid line comment', start);
  }

  #skipBlockComment(): void {
    const start = this.#index;
    const end = this.#source.indexOf('*/', this.#index + 2);
    if (end === -1) throw this.#error('Unterminated block comment', start);
    this.#index = end + 2;
  }

  #scanQuotedString(quote: string): SourceToken {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index]!;
      if (character === quote) {
        this.#index += 1;
        return { kind: 'literal', value: 'string', offset: start };
      }
      if (character === '\\') {
        this.#index += 1;
        if (this.#index >= this.#source.length) break;
        if (this.#source[this.#index] === '\r' && this.#source[this.#index + 1] === '\n') {
          this.#index += 2;
        } else {
          this.#index += 1;
        }
        continue;
      }
      if (/[\r\n\u2028\u2029]/u.test(character)) {
        throw this.#error('Unterminated string literal', start);
      }
      this.#index += 1;
    }
    throw this.#error('Unterminated string literal', start);
  }

  #scanTemplate(templateDepth: number): SourceToken {
    const start = this.#index;
    if (templateDepth >= MAX_TEMPLATE_NESTING) {
      throw this.#error('Workflow source exceeds the template nesting limit', start);
    }
    this.#index += 1;
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index]!;
      if (character === '`') {
        this.#index += 1;
        return { kind: 'literal', value: 'template', offset: start };
      }
      if (character === '\\') {
        this.#index += 2;
        continue;
      }
      if (character === '$' && this.#source[this.#index + 1] === '{') {
        this.#index += 2;
        this.#scanCode(true, templateDepth + 1);
        continue;
      }
      this.#index += 1;
    }
    throw this.#error('Unterminated template literal', start);
  }

  #scanRegex(): SourceToken {
    const start = this.#index;
    this.#index += 1;
    let inCharacterClass = false;
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index]!;
      if (character === '\\') {
        this.#index += 2;
        continue;
      }
      if (/[\r\n\u2028\u2029]/u.test(character)) {
        throw this.#error('Unterminated regular expression literal', start);
      }
      if (character === '[') inCharacterClass = true;
      if (character === ']') inCharacterClass = false;
      this.#index += 1;
      if (character === '/' && !inCharacterClass) {
        while (this.#isIdentifierPart()) this.#readIdentifierCharacter();
        return { kind: 'literal', value: 'regex', offset: start };
      }
    }
    throw this.#error('Unterminated regular expression literal', start);
  }

  #scanIdentifier(): SourceToken {
    const start = this.#index;
    let value = '';
    value += this.#readIdentifierCharacter(true);
    while (this.#isIdentifierPart()) value += this.#readIdentifierCharacter(false);
    return { kind: 'identifier', value, offset: start };
  }

  #scanNumber(): SourceToken {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#source.length && /[0-9A-Za-z_.]/u.test(this.#source[this.#index]!)) {
      this.#index += 1;
    }
    return { kind: 'literal', value: 'number', offset: start };
  }

  #scanPunctuator(): SourceToken {
    const start = this.#index;
    const value =
      PUNCTUATORS.find((candidate) => this.#source.startsWith(candidate, this.#index)) ??
      this.#source[this.#index]!;
    this.#index += value.length;
    return { kind: 'punctuator', value, offset: start };
  }

  #canStartRegex(previous: SourceToken | undefined): boolean {
    if (!previous) return true;
    if (previous.kind === 'identifier') return REGEX_PREFIX_IDENTIFIERS.has(previous.value);
    return previous.kind === 'punctuator' && REGEX_PREFIX_PUNCTUATORS.has(previous.value);
  }

  #isIdentifierStart(): boolean {
    return this.#isIdentifierCharacter(true);
  }

  #isIdentifierPart(): boolean {
    return this.#isIdentifierCharacter(false);
  }

  #isIdentifierCharacter(start: boolean): boolean {
    const character = this.#source[this.#index];
    if (!character) return false;
    if (character === '\\') return this.#source[this.#index + 1] === 'u';
    const codePoint = this.#source.codePointAt(this.#index);
    if (codePoint === undefined) return false;
    const value = String.fromCodePoint(codePoint);
    return (start ? IDENTIFIER_START : IDENTIFIER_PART).test(value);
  }

  #readIdentifierCharacter(start = false): string {
    const offset = this.#index;
    if (this.#source[this.#index] !== '\\') {
      const codePoint = this.#source.codePointAt(this.#index);
      if (codePoint === undefined) throw this.#error('Invalid identifier', offset);
      const value = String.fromCodePoint(codePoint);
      if (!(start ? IDENTIFIER_START : IDENTIFIER_PART).test(value)) {
        throw this.#error('Invalid identifier character', offset);
      }
      this.#index += value.length;
      return value;
    }

    this.#index += 2;
    let digits = '';
    if (this.#source[this.#index] === '{') {
      this.#index += 1;
      const end = this.#source.indexOf('}', this.#index);
      if (end === -1) throw this.#error('Unterminated Unicode identifier escape', offset);
      digits = this.#source.slice(this.#index, end);
      this.#index = end + 1;
      if (!/^[0-9A-Fa-f]{1,6}$/u.test(digits)) {
        throw this.#error('Invalid Unicode identifier escape', offset);
      }
    } else {
      digits = this.#source.slice(this.#index, this.#index + 4);
      this.#index += 4;
      if (!/^[0-9A-Fa-f]{4}$/u.test(digits)) {
        throw this.#error('Invalid Unicode identifier escape', offset);
      }
    }
    const codePoint = Number.parseInt(digits, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw this.#error('Invalid Unicode identifier code point', offset);
    }
    const value = String.fromCodePoint(codePoint);
    if (!(start ? IDENTIFIER_START : IDENTIFIER_PART).test(value)) {
      throw this.#error('Invalid escaped identifier character', offset);
    }
    return value;
  }

  #error(message: string, offset = this.#index): WorkflowRunnerSourcePolicyError {
    return new WorkflowRunnerSourcePolicyError(message, offset);
  }
}

function nextToken(tokens: readonly SourceToken[], index: number): SourceToken | undefined {
  return tokens[index + 1];
}

function assertNoExportFrom(tokens: readonly SourceToken[], exportIndex: number): void {
  let index = exportIndex + 1;
  if (tokens[index]?.kind === 'identifier' && tokens[index]?.value === 'type') index += 1;
  const first = tokens[index];
  if (!first || (first.value !== '*' && first.value !== '{')) return;

  let braceDepth = 0;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.value === '{') braceDepth += 1;
    if (token.value === '}') braceDepth -= 1;
    if (token.value === ';' && braceDepth === 0) return;
    if (
      braceDepth === 0 &&
      token.kind === 'identifier' &&
      token.value === 'from' &&
      nextToken(tokens, index)?.kind === 'literal' &&
      nextToken(tokens, index)?.value === 'string'
    ) {
      throw new WorkflowRunnerSourcePolicyError(
        'GS8 sealed workflow source may not re-export from another module',
        token.offset,
      );
    }
  }
}

/**
 * Enforces source closure only for the default-off GS8 worker path. The legacy
 * CLI loader intentionally does not call this policy.
 */
export function assertWorkflowRunnerSourceIsSelfContained(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_POLICY_SOURCE_BYTES) {
    throw new WorkflowRunnerSourcePolicyError(
      'Workflow source exceeds the policy byte limit',
      bytes.byteLength,
    );
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new WorkflowRunnerSourcePolicyError('Workflow source is not valid UTF-8', 0);
  }
  const tokens = new BoundedJavaScriptLexer(source).scan();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== 'identifier') continue;
    if (token.value === 'require') {
      throw new WorkflowRunnerSourcePolicyError(
        'GS8 sealed workflow source may not reference require',
        token.offset,
      );
    }
    if (DYNAMIC_SOURCE_EVALUATORS.has(token.value)) {
      throw new WorkflowRunnerSourcePolicyError(
        'GS8 sealed workflow source may not dynamically evaluate source text',
        token.offset,
      );
    }
    if (token.value === 'import' && nextToken(tokens, index)?.value !== '.') {
      throw new WorkflowRunnerSourcePolicyError(
        'GS8 sealed workflow source may not contain static or dynamic imports',
        token.offset,
      );
    }
    if (token.value === 'export') assertNoExportFrom(tokens, index);
  }
}
