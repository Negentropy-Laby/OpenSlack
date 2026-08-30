import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkflowRunnerDescriptorPathSecurity } from '../../packages/workflows/src/workflow-runner-descriptor-store.js';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');
const REQUIRED_BUN_VERSION = '1.3.11';
const ENTRYPOINT = join(
  REPOSITORY_ROOT,
  'packages',
  'workflows',
  'src',
  'workflow-runner-worker-bin.ts',
);
const ARTIFACT = join(
  REPOSITORY_ROOT,
  'packages',
  'workflows',
  'dist',
  'workflow-runner-worker-bundle.cjs',
);
const STAGED_ENTRYPOINT = 'workflow-runner-worker.cjs';
const STAGED_EXECUTABLE = process.platform === 'win32' ? 'runner-node.exe' : 'runner-node';
const STAGED_MANIFEST = 'workflow-runner-bundle.v1.json';
const EXPECTED_FILES = [STAGED_ENTRYPOINT, STAGED_EXECUTABLE, STAGED_MANIFEST].sort();
const DEFAULT_OFF_DIAGNOSTIC =
  '[WORKFLOW_RUNNER_WORKER_START_FAILED] WorkflowRunnerWorkerConfigError\n';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkoutRepresentations(root: string): string[] {
  const normalized = root.replaceAll('\\', '/');
  const escapedNative = JSON.stringify(root).slice(1, -1);
  return [...new Set([root, escapedNative, normalized, pathToFileURL(root).href])].filter(
    (candidate) => candidate.length > 0,
  );
}

function assertNoCheckoutPaths(bytes: Uint8Array, roots: readonly string[]): void {
  const artifact = Buffer.from(bytes).toString('utf8');
  for (const root of roots) {
    for (const representation of checkoutRepresentations(root)) {
      if (artifact.includes(representation)) {
        throw new Error('Sealed runner artifact contains a build checkout path.');
      }
    }
  }
}

async function buildBundle(): Promise<{ bytes: Buffer; hash: string }> {
  await mkdir(dirname(ARTIFACT), { recursive: true });
  await rm(ARTIFACT, { force: true });
  const result = spawnSync(
    process.execPath,
    ['build', ENTRYPOINT, '--target=node', '--format=cjs', '--bundle', `--outfile=${ARTIFACT}`],
    {
      cwd: REPOSITORY_ROOT,
      env: process.env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Sealed runner build failed with exit ${String(result.status)}.`);
  }
  const bytes = await readFile(ARTIFACT);
  assertNoCheckoutPaths(bytes, [REPOSITORY_ROOT]);
  await chmod(ARTIFACT, 0o600);
  const hash = sha256(bytes);
  process.stdout.write(`workflow-runner-bundle sha256=${hash} bytes=${bytes.length}\n`);
  return { bytes, hash };
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Bundle root already exists.');
}

async function stageBundle(bundleRoot: string, nodeExecutable: string): Promise<void> {
  if (!isAbsolute(bundleRoot) || !isAbsolute(nodeExecutable)) {
    throw new Error('Bundle root and Node executable must be absolute paths.');
  }
  const executableStat = await lstat(nodeExecutable);
  if (!executableStat.isFile() || executableStat.isSymbolicLink()) {
    throw new Error('Node executable must be a regular non-symlink file.');
  }
  await requireAbsent(bundleRoot);
  await mkdir(bundleRoot, { mode: 0o700 });
  const security = createWorkflowRunnerDescriptorPathSecurity();
  await security.harden(bundleRoot, true);

  const built = await buildBundle();
  const entrypointPath = join(bundleRoot, STAGED_ENTRYPOINT);
  const executablePath = join(bundleRoot, STAGED_EXECUTABLE);
  const manifestPath = join(bundleRoot, STAGED_MANIFEST);
  await copyFile(ARTIFACT, entrypointPath);
  await copyFile(nodeExecutable, executablePath);
  await security.harden(entrypointPath, false);
  await security.harden(executablePath, false);

  const executableBytes = await readFile(executablePath);
  const manifest = {
    schema: 'openslack.workflow_runner_bundle.v1',
    bundleId: 'gs8b.ci.bundle',
    runnerBuildHash: built.hash,
    executable: { relativePath: STAGED_EXECUTABLE, sha256: sha256(executableBytes) },
    entrypoint: { relativePath: STAGED_ENTRYPOINT, sha256: built.hash },
    entrypointMode: 'first-argument',
    fixedArguments: [],
    fixedEnvironment: ['NODE_ENV=test'],
    workingDirectory: '.',
  } as const;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await security.harden(manifestPath, false);

  const names = (await readdir(bundleRoot)).sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_FILES)) {
    throw new Error('Staged runner bundle must contain exactly three files.');
  }
  for (const [path, directory] of [
    [bundleRoot, true],
    [entrypointPath, false],
    [executablePath, false],
    [manifestPath, false],
  ] as const) {
    const current = await lstat(path, { bigint: true });
    await security.assertOwnerOnly(path, directory, current);
  }
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('OPENSLACK_WORKFLOW_')) delete env[key];
  }
  return env;
}

function runChecked(executable: string, args: readonly string[], cwd: string, label: string): void {
  const result = spawnSync(executable, [...args], {
    cwd,
    env: childEnvironment(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed with exit ${String(result.status)}.`);
  }
}

async function verifyLocal(nodeExecutable: string): Promise<void> {
  const ancestor = await mkdtemp(join(tmpdir(), 'openslack-runner-type-module-'));
  const bundleRoot = join(ancestor, 'sealed', 'bundle');
  try {
    await writeFile(join(ancestor, 'package.json'), '{"type":"module"}\n', 'utf8');
    await mkdir(dirname(bundleRoot), { recursive: true });
    await stageBundle(bundleRoot, nodeExecutable);
    const entrypoint = join(bundleRoot, STAGED_ENTRYPOINT);
    const stagedNode = join(bundleRoot, STAGED_EXECUTABLE);
    runChecked(stagedNode, ['--check', entrypoint], bundleRoot, 'CommonJS syntax check');
    const smoke = spawnSync(stagedNode, [entrypoint], {
      cwd: bundleRoot,
      env: childEnvironment(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
    if (
      smoke.error ||
      smoke.status !== 1 ||
      smoke.stdout !== '' ||
      smoke.stderr !== DEFAULT_OFF_DIAGNOSTIC
    ) {
      throw new Error('Sealed runner default-off smoke did not return the stable diagnostic.');
    }
    const bytes = await readFile(entrypoint);
    assertNoCheckoutPaths(bytes, [REPOSITORY_ROOT, ancestor]);
  } finally {
    await rm(ancestor, { recursive: true, force: true });
  }
}

function listedWorktreeFiles(): string[] {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error('Unable to enumerate the non-ignored worktree.');
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0);
}

async function copyWorktree(destination: string, files: readonly string[]): Promise<void> {
  for (const path of files) {
    const sourcePath = resolve(REPOSITORY_ROOT, path);
    const destinationPath = resolve(destination, path);
    const rel = relative(destination, destinationPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Worktree inventory contains an unsafe path.');
    }
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
}

async function buildInReplica(root: string, bunExecutable: string): Promise<Buffer> {
  runChecked(bunExecutable, ['install', '--frozen-lockfile'], root, 'Frozen install');
  runChecked(bunExecutable, ['run', 'build'], root, 'Replica workspace build');
  runChecked(
    bunExecutable,
    ['scripts/qualification/workflow-runner-bundle.ts', 'build'],
    root,
    'Replica sealed runner build',
  );
  return readFile(join(root, 'packages', 'workflows', 'dist', 'workflow-runner-worker-bundle.cjs'));
}

async function verifyReproducible(nodeExecutable: string): Promise<void> {
  const bunExecutable = process.execPath;
  const first = await mkdtemp(join(tmpdir(), 'openslack-runner-repro-a-'));
  const second = await mkdtemp(join(tmpdir(), 'openslack-runner-repro-different-length-b-'));
  try {
    const files = listedWorktreeFiles();
    await Promise.all([copyWorktree(first, files), copyWorktree(second, files)]);
    const [firstBytes, secondBytes] = await Promise.all([
      buildInReplica(first, bunExecutable),
      buildInReplica(second, bunExecutable),
    ]);
    if (!firstBytes.equals(secondBytes)) {
      throw new Error('Sealed runner bundle is not byte-reproducible across checkout roots.');
    }
    assertNoCheckoutPaths(firstBytes, [REPOSITORY_ROOT, first, second]);
    assertNoCheckoutPaths(secondBytes, [REPOSITORY_ROOT, first, second]);
    const hash = sha256(firstBytes);
    process.stdout.write(
      `workflow-runner-reproducible sha256=${hash} bytes=${firstBytes.length}\n`,
    );
    await verifyLocal(nodeExecutable);
  } finally {
    await Promise.all([
      rm(first, { recursive: true, force: true }),
      rm(second, { recursive: true, force: true }),
    ]);
  }
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length || args[index + 1]!.startsWith('--')) {
    throw new Error(`Missing required ${name} option.`);
  }
  return resolve(args[index + 1]!);
}

async function main(): Promise<void> {
  if (process.versions['bun'] !== REQUIRED_BUN_VERSION) {
    throw new Error(`Sealed runner qualification requires Bun ${REQUIRED_BUN_VERSION}.`);
  }
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'build':
      if (args.length !== 0) throw new Error('build does not accept options.');
      await buildBundle();
      return;
    case 'stage': {
      const bundleRoot = option(args, '--bundle-root');
      const nodeExecutable = option(args, '--node-executable');
      if (args.length !== 4) throw new Error('stage received unknown or duplicate options.');
      await stageBundle(bundleRoot, nodeExecutable);
      return;
    }
    case 'verify-local': {
      const nodeExecutable = option(args, '--node-executable');
      if (args.length !== 2) throw new Error('verify-local received unknown or duplicate options.');
      await verifyLocal(nodeExecutable);
      return;
    }
    case 'verify-reproducible': {
      const nodeExecutable = option(args, '--node-executable');
      if (args.length !== 2) {
        throw new Error('verify-reproducible received unknown or duplicate options.');
      }
      await verifyReproducible(nodeExecutable);
      return;
    }
    default:
      throw new Error('Expected build, stage, verify-local, or verify-reproducible command.');
  }
}

await main();
