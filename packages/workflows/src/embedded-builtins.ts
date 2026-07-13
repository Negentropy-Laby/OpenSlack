import * as profileSync from './builtins/profile-sync.js';
import type { WorkflowModule } from './types.js';

const PREFIX = 'openslack:builtin/';

const BUILTINS: Readonly<Record<string, WorkflowModule>> = {
  'profile-sync': profileSync as unknown as WorkflowModule,
};

export function listEmbeddedBuiltins(): Array<{
  name: string;
  path: string;
  module: WorkflowModule;
}> {
  return Object.entries(BUILTINS).map(([name, module]) => ({
    name,
    path: `${PREFIX}${name}`,
    module,
  }));
}

export function getEmbeddedBuiltin(path: string): WorkflowModule | undefined {
  return path.startsWith(PREFIX) ? BUILTINS[path.slice(PREFIX.length)] : undefined;
}
