import graphDeltaSchema from './generated/contracts/v1/schemas/graph-delta.v1.schema.json' with { type: 'json' };
import graphSnapshotSchema from './generated/contracts/v1/schemas/graph-snapshot.v1.schema.json' with { type: 'json' };

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export const graphSnapshotJsonSchema = deepFreeze(graphSnapshotSchema);
export const graphDeltaJsonSchema = deepFreeze(graphDeltaSchema);
