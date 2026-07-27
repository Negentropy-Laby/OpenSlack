import mcpResultV2Schema from './mcp-result.v2.schema.json' with { type: 'json' };

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export const openSlackMcpResultV2JsonSchema = deepFreeze(mcpResultV2Schema);
