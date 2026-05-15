import workspaceSchema from './workspace.schema.json' with { type: 'json' };
import agentRegistrySchema from './agent-registry.schema.json' with { type: 'json' };
import evolutionTaskSchema from './evolution-task.schema.json' with { type: 'json' };
import taskSchema from './task.schema.json' with { type: 'json' };
import leaseSchema from './lease.schema.json' with { type: 'json' };
import runRecordSchema from './run-record.schema.json' with { type: 'json' };

export const schemas = {
  workspace: workspaceSchema,
  agentRegistry: agentRegistrySchema,
  evolutionTask: evolutionTaskSchema,
  task: taskSchema,
  lease: leaseSchema,
  runRecord: runRecordSchema,
} as const;

export { workspaceSchema, agentRegistrySchema, evolutionTaskSchema, taskSchema, leaseSchema, runRecordSchema };
