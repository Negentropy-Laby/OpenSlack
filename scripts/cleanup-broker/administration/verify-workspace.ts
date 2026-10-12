import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCleanupWorkspace } from '@openslack/pr';
import type { VerifyCleanupWorkspaceInput } from '@openslack/pr';
export { verifyCleanupWorkspace } from '@openslack/pr';
export type { VerifyCleanupWorkspaceInput, CleanupWorkspaceObservation } from '@openslack/pr';

export function parseVerifyWorkspaceArguments(args: string[]): VerifyCleanupWorkspaceInput {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (
      !['--workspace', '--selected-bindings', '--selected-bindings-sha256'].includes(key) ||
      !value ||
      value.startsWith('--') ||
      options.has(key)
    )
      throw new Error('WORKSPACE_ARGUMENT_INVALID');
    options.set(key, value);
  }
  if (options.size !== 3 || !/^[a-f0-9]{64}$/.test(options.get('--selected-bindings-sha256')!))
    throw new Error('WORKSPACE_ARGUMENT_INVALID');
  for (const key of ['--workspace', '--selected-bindings'])
    if (!isAbsolute(options.get(key)!) || /[\u0000-\u001f\u007f]/.test(options.get(key)!))
      throw new Error('WORKSPACE_ARGUMENT_INVALID');
  return {
    workspace: options.get('--workspace')!,
    selectedBindings: options.get('--selected-bindings')!,
    selectedBindingsSHA256: options.get('--selected-bindings-sha256')!,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyCleanupWorkspace(parseVerifyWorkspaceArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === 'PASS' ? 0 : 2;
  } catch {
    process.stderr.write(
      'WORKSPACE_ARGUMENT_INVALID: usage: verify-workspace.mjs --workspace <absolute directory> --selected-bindings <strict JSON selection> --selected-bindings-sha256 <SHA256>\n',
    );
    process.exitCode = 2;
  }
}
