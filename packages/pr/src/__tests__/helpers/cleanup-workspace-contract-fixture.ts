// Test-only module interception. Never imported by an installed workspace tool.
import { realpathSync } from 'node:fs';
import * as nativePath from 'node:path';

type PathApi = Pick<typeof nativePath, 'join' | 'resolve'>;
export function contractModulePaths(root: string, paths: PathApi = nativePath): [string, string] {
  return [
    paths.join(root, 'packages', 'pr', 'src', 'internal', 'cleanup-administration-contract.ts'),
    paths.join(root, 'packages', 'pr', 'dist', 'internal', 'cleanup-administration-contract.js'),
  ];
}

export function contractFixtureLoader(
  root: string,
  contents: string,
  options: {
    paths?: PathApi;
    platform?: NodeJS.Platform;
    canonicalize?: (path: string) => string;
  } = {},
) {
  const paths = options.paths ?? nativePath;
  const allowed = contractModulePaths(root, paths).map((path) => paths.resolve(path));
  const canonicalize = options.canonicalize ?? realpathSync.native;
  const key = (path: string) =>
    (options.platform ?? process.platform) === 'win32' ? path.toLowerCase() : path;
  const canonical = allowed.map((path) => key(paths.resolve(canonicalize(path))));
  const refuse = (resolved: string): never => {
    throw new Error(`UNEXPECTED_CONTRACT_PATH: ${resolved}; allowed=${JSON.stringify(allowed)}`);
  };
  return {
    allowed,
    onLoad({ path }: { path: string }) {
      const resolved = paths.resolve(path);
      const index = allowed.findIndex((path) => key(path) === key(resolved));
      if (index < 0) refuse(resolved);
      try {
        if (key(paths.resolve(canonicalize(resolved))) !== canonical[index]) refuse(resolved);
      } catch {
        refuse(resolved);
      }
      return { contents, loader: 'ts' as const };
    },
  };
}

// Explicit data module: do not splice the generated production TS template.
export function contractFixtureModule(contract: unknown): string {
  return `const contract = ${JSON.stringify(contract)} as const;
export const CLEANUP_ADMIN_BINDINGS = Object.freeze(contract.bindings);
export const CLEANUP_ADMIN_IDENTITIES = Object.freeze({broker: Object.freeze(contract.identities.broker), agent: Object.freeze(contract.identities.agent)});
export const CLEANUP_INSTALL_LAYOUT = Object.freeze(contract.layout.map(entry => Object.freeze(entry)));
export const CLEANUP_RUNTIME_BINDING = Object.freeze(contract.runtimeBinding);
export const CLEANUP_FIXTURE_OPERATOR = Object.freeze(contract.fixtureOperator);
export const CLEANUP_GOVERNANCE_BINDING = Object.freeze(contract.governance);
export const CLEANUP_TASK_STATES = Object.freeze(contract.taskStates);
export type CleanupTaskState = (typeof CLEANUP_TASK_STATES)[number];
export const CLEANUP_TASK_LIMIT = contract.taskLimit;
export const CLEANUP_REGISTRY_SHA256 = contract.registrySHA256;
`;
}
