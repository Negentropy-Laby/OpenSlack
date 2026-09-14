export function testProcessEnvironment(parent?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function testExecutable(command: 'node' | 'bun' | 'git', env?: NodeJS.ProcessEnv): string;
export function testBash(
  env?: NodeJS.ProcessEnv,
  suppliedCandidates?: readonly string[],
): {
  executable: string;
  env: NodeJS.ProcessEnv;
  path(value: string): string;
};
