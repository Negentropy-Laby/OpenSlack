import * as profileSync from './builtins/profile-sync.js';
import type { OpenSlackWorkflow } from './types.js';

const PREFIX = 'openslack:builtin/';

const BUILTINS: Readonly<Record<string, OpenSlackWorkflow>> = Object.freeze({
  'profile-sync': { meta: profileSync.meta, preview: profileSync.preview, run: profileSync.run },
});

export function listEmbeddedBuiltins(): Array<{
  name: string;
  path: string;
  module: OpenSlackWorkflow;
}> {
  return Object.entries(BUILTINS).map(([name, module]) => ({
    name,
    path: `${PREFIX}${name}`,
    module,
  }));
}

export function getEmbeddedBuiltin(path: string): OpenSlackWorkflow | undefined {
  return path.startsWith(PREFIX) ? BUILTINS[path.slice(PREFIX.length)] : undefined;
}
