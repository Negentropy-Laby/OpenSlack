import schema from './schemas/agent-registry-v2.schema.json' with { type: 'json' };

// The schema is the single authority for portable, case-preserving agent IDs.
const agentIdPattern = new RegExp(schema.properties.agent_id.pattern);
export function isSafeAgentId(value: unknown): value is string {
  return typeof value === 'string' && agentIdPattern.test(value);
}
