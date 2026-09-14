import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';
export function testProcessEnvironment(
  parent?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): NodeJS.ProcessEnv;
export function testExecutable(command: 'node' | 'bun' | 'git', env?: NodeJS.ProcessEnv): string;
export function testBash(
  env?: NodeJS.ProcessEnv,
  suppliedCandidates?: readonly string[],
): {
  executable: string;
  env: NodeJS.ProcessEnv;
  path(value: string): string;
  spawn(
    args: readonly string[],
    options?: Partial<SpawnSyncOptionsWithStringEncoding>,
  ): SpawnSyncReturns<string>;
};

export function platformTestTimeout(baseMs: number, windowsMs?: number): number;
export function createTestProcessResolver(
  parent?: NodeJS.ProcessEnv,
  cwd?: string,
): {
  env: NodeJS.ProcessEnv;
  cwd: string;
  executable(command: string): string;
};
