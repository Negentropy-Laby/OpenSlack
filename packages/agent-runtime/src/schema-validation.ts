import { ProviderInvalidResponseError } from './types.js';
import { redactSensitiveText } from './sensitive-data.js';

const AGENT_RESULT_SCHEMA_SUMMARY_MAX_BYTES = 1024;
const AGENT_RESULT_SCHEMA_SUMMARY_PREFIX =
  'Agent execution provider result failed schema validation: ';

export interface AgentResultSchema {
  type?: string | string[];
  properties?: Record<string, AgentResultSchema>;
  items?: AgentResultSchema | AgentResultSchema[];
  required?: string[];
  enum?: unknown[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export class AgentResultSchemaError extends ProviderInvalidResponseError {
  readonly violations: string[];

  constructor(violations: string[]) {
    super('Agent execution provider result failed schema validation.');
    this.name = 'AgentResultSchemaError';
    this.violations = violations;
  }
}

const internalAgentResultSchemaErrors = new WeakSet<AgentResultSchemaError>();

export function isInternalAgentResultSchemaError(error: AgentResultSchemaError): boolean {
  return internalAgentResultSchemaErrors.has(error);
}

function internalAgentResultSchemaError(violations: string[]): AgentResultSchemaError {
  const error = new AgentResultSchemaError(violations);
  internalAgentResultSchemaErrors.add(error);
  return error;
}

export function validateAgentResultSchema(
  data: unknown,
  schema: AgentResultSchema,
  path = 'root',
): string[] {
  const violations: string[] = [];
  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data;
    if (!expected.includes(actual)) {
      violations.push(`${path}: expected ${expected.join('|')}, received ${actual}`);
      return violations;
    }
  }
  if (schema.enum && !schema.enum.some((item) => Object.is(item, data))) {
    violations.push(`${path}: value is not in the allowed enum`);
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const object = data as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(object, required)) {
        violations.push(`${path}.${required}: required property missing`);
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        violations.push(
          ...validateAgentResultSchema(object[key], propertySchema, `${path}.${key}`),
        );
      }
    }
    if (
      schema.additionalProperties === false &&
      Object.keys(object).some(
        (key) => !Object.prototype.hasOwnProperty.call(schema.properties ?? {}, key),
      )
    ) {
      violations.push(`${path}: additional property is not allowed`);
    }
  }
  if (schema.items && Array.isArray(data)) {
    for (const [index, item] of data.entries()) {
      const itemSchema = Array.isArray(schema.items) ? schema.items[index] : schema.items;
      if (itemSchema) {
        violations.push(...validateAgentResultSchema(item, itemSchema, `${path}[${index}]`));
      }
    }
  }
  return violations;
}

export function assertAgentResultSchema(data: unknown, schema: unknown): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw internalAgentResultSchemaError(['root: schema must be an object']);
  }
  const violations = validateAgentResultSchema(data, schema as AgentResultSchema);
  if (violations.length > 0) throw internalAgentResultSchemaError(violations);
}

/**
 * Build a bounded operator-safe summary from internally generated schema
 * violations. Provider values and unknown property names are never included.
 */
export function formatAgentResultSchemaFailureSummary(violations: readonly string[]): string {
  const normalized = [
    ...new Set(
      violations.map(
        (violation) => redactSensitiveText(violation.replace(/[\r\n\t]+/gu, ' ').trim()).value,
      ),
    ),
  ].filter((violation) => violation.length > 0);
  const details = normalized.join('; ') || 'schema validation failed';
  const count = normalized.length || 1;
  const countLabel = `${count} violation${count === 1 ? '' : 's'}`;
  const completeSuffix = ` [${countLabel}]`;
  const complete = `${AGENT_RESULT_SCHEMA_SUMMARY_PREFIX}${details}${completeSuffix}`;
  if (Buffer.byteLength(complete, 'utf8') <= AGENT_RESULT_SCHEMA_SUMMARY_MAX_BYTES) {
    return complete;
  }

  const truncatedSuffix = ` [${countLabel}; truncated]`;
  const detailBytes =
    AGENT_RESULT_SCHEMA_SUMMARY_MAX_BYTES -
    Buffer.byteLength(AGENT_RESULT_SCHEMA_SUMMARY_PREFIX + truncatedSuffix, 'utf8');
  return `${AGENT_RESULT_SCHEMA_SUMMARY_PREFIX}${truncateUtf8(details, detailBytes)}${truncatedSuffix}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}
