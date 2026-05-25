import workspaceSchema from './workspace.schema.json' with { type: 'json' };
import agentRegistrySchema from './agent-registry.schema.json' with { type: 'json' };
import agentRegistryV2Schema from './agent-registry-v2.schema.json' with { type: 'json' };
import evolutionTaskSchema from './evolution-task.schema.json' with { type: 'json' };
import taskSchema from './task.schema.json' with { type: 'json' };
import leaseSchema from './lease.schema.json' with { type: 'json' };
import runRecordSchema from './run-record.schema.json' with { type: 'json' };

export const schemas = {
  workspace: workspaceSchema,
  agentRegistry: agentRegistrySchema,
  agentRegistryV2: agentRegistryV2Schema,
  evolutionTask: evolutionTaskSchema,
  task: taskSchema,
  lease: leaseSchema,
  runRecord: runRecordSchema,
} as const;

export { workspaceSchema, agentRegistrySchema, agentRegistryV2Schema, evolutionTaskSchema, taskSchema, leaseSchema, runRecordSchema };
