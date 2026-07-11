import { ProviderInvalidResponseError } from './types.js';

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
  if (schema.properties && data && typeof data === 'object' && !Array.isArray(data)) {
    const object = data as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in object)) violations.push(`${path}.${required}: required property missing`);
    }
    for (const [key, value] of Object.entries(object)) {
      const propertySchema = schema.properties[key];
      if (propertySchema) {
        violations.push(...validateAgentResultSchema(value, propertySchema, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        violations.push(`${path}.${key}: additional property is not allowed`);
      }
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
    throw new AgentResultSchemaError(['root: schema must be an object']);
  }
  const violations = validateAgentResultSchema(data, schema as AgentResultSchema);
  if (violations.length > 0) throw new AgentResultSchemaError(violations);
}
