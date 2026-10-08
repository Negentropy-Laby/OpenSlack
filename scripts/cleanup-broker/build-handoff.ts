import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CleanupHandoffError,
  assertCleanupHandoffStaging,
  assertCleanupHandoffRuntime,
  readCleanupHandoffInputFile,
  prepareCleanupHandoffDraft,
} from '../../packages/pr/src/cleanup-handoff.js';
import type {
  CleanupHandoffBuildInput,
  PrepareCleanupHandoffDraftInput,
} from '../../packages/pr/src/cleanup-handoff.js';

// Orchestrates two clean builds; all draft construction/verification belongs to @openslack/pr.
type BuildInput = Omit<PrepareCleanupHandoffDraftInput, 'builds' | 'verifierPath' | 'now'> & {
  buildDirectory: string;
};
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (command: string, args: string[], cwd: string, env = process.env) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--input' || !args[1])
    throw new CleanupHandoffError('HANDOFF_INPUT_INVALID');
  const input = readCleanupHandoffInputFile(args[1]) as BuildInput;
  if ('now' in input || process.platform !== 'linux' || !/^[a-f0-9]{40}$/.test(input.candidateHead))
    throw new CleanupHandoffError('HANDOFF_INPUT_INVALID');
  const { sourceRoot: source } = assertCleanupHandoffStaging(input);
  const { outputDirectory: buildRoot } = assertCleanupHandoffStaging({
    ...input,
    outputDirectory: input.buildDirectory,
  });
  if (resolve(input.outputDirectory) === buildRoot)
    throw new CleanupHandoffError('HANDOFF_PATH_UNSAFE');
  const node = assertCleanupHandoffRuntime(input);
  const tools = {
    bun: Bun.version,
    go: run('go', ['version'], source),
    node: run(node, ['--version'], source),
  };
  if (
    tools.bun !== '1.4.0' ||
    tools.go !== 'go version go1.26.5 linux/amd64' ||
    tools.node !== 'v24.18.1'
  )
    throw new CleanupHandoffError('HANDOFF_BUILD_MISMATCH');
  mkdirSync(buildRoot, { mode: 0o755 });
  const build = (id: string): CleanupHandoffBuildInput => {
    const checkout = join(buildRoot, `source-${id}`),
      artifacts = join(buildRoot, `build-${id}`);
    run('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', source, checkout], source);
    run('git', ['checkout', '--quiet', '--detach', input.candidateHead], checkout);
    if (run('git', ['status', '--porcelain'], checkout))
      throw new CleanupHandoffError('HANDOFF_SOURCE_DIRTY');
    // --no-hardlinks is mandatory, and verify the cloned object files are single-link.
    const objectFiles = run('git', ['rev-parse', '--git-path', 'objects'], checkout);
    if (!existsSync(resolve(checkout, objectFiles)))
      throw new CleanupHandoffError('HANDOFF_BUILD_MISMATCH');
    const verifyObjects = (directory: string) => {
      const root = lstatSync(directory);
      if (root.isSymbolicLink() || !root.isDirectory())
        throw new CleanupHandoffError('HANDOFF_PATH_UNSAFE');
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name),
          stamp = lstatSync(path);
        if (
          stamp.isSymbolicLink() ||
          (stamp.isFile() && stamp.nlink !== 1) ||
          path.endsWith('/info/alternates')
        )
          throw new CleanupHandoffError('HANDOFF_BUILD_MISMATCH');
        if (stamp.isDirectory()) verifyObjects(path);
      }
    };
    verifyObjects(resolve(checkout, objectFiles));
    run(process.execPath, ['install', '--frozen-lockfile', '--ignore-scripts'], checkout);
    mkdirSync(artifacts);
    const brokerPath = join(artifacts, 'cleanup-broker'),
      executorPath = join(artifacts, 'executor.mjs');
    const goEnv = { ...process.env, GOWORK: 'off', CGO_ENABLED: '0' };
    run(
      'go',
      ['build', '-trimpath', '-buildvcs=true', '-o', brokerPath, './cmd/cleanup-broker'],
      join(checkout, 'services/cleanup-broker'),
      goEnv,
    );
    run(
      process.execPath,
      ['scripts/cleanup-broker/build-executor.ts', '--outdir', artifacts],
      checkout,
    );
    const bundle = Bun.spawnSync(
      [
        process.execPath,
        'build',
        'scripts/cleanup-broker/verify-handoff.ts',
        '--target=node',
        '--format=esm',
        '--outfile',
        join(artifacts, 'verify-handoff.mjs'),
      ],
      { cwd: checkout, stdout: 'pipe', stderr: 'pipe' },
    );
    if (bundle.exitCode !== 0) throw new CleanupHandoffError('HANDOFF_BUILD_MISMATCH');
    const brokerBuildMetadata = run('go', ['version', '-m', brokerPath], checkout).split('\n');
    if (
      !brokerBuildMetadata.some((line) => line.includes(`vcs.revision=${input.candidateHead}`)) ||
      !brokerBuildMetadata.some((line) => line.includes('vcs.modified=false'))
    )
      throw new CleanupHandoffError('HANDOFF_BUILD_MISMATCH');
    const reportPath = join(artifacts, 'build-report.json');
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          schema: 'openslack.pr418.clean-build-report.v1',
          candidateHead: input.candidateHead,
          checkout,
          checkoutCleanAfterBuild: run('git', ['status', '--porcelain'], checkout) === '',
          independentCloneNoHardlinks: true,
          tools,
          brokerBuildMetadata,
          lockfileSHA256: hash(join(checkout, 'bun.lock')),
          goModuleSHA256: hash(join(checkout, 'services/cleanup-broker/go.mod')),
          commands: [
            'git clone --no-hardlinks --no-checkout <source> <checkout>',
            `git checkout --detach ${input.candidateHead}`,
            'bun install --frozen-lockfile --ignore-scripts',
            'GOWORK=off CGO_ENABLED=0 go build -trimpath -buildvcs=true -o <artifact-directory>/cleanup-broker ./cmd/cleanup-broker',
            'bun scripts/cleanup-broker/build-executor.ts --outdir <artifact-directory>',
            'bun build scripts/cleanup-broker/verify-handoff.ts --target=node --format=esm --outfile <artifact-directory>/verify-handoff.mjs',
          ],
          broker: { sha256: hash(brokerPath), bytes: statSync(brokerPath).size },
          executor: { sha256: hash(executorPath), bytes: statSync(executorPath).size },
          scope: 'Clean build and byte integrity only; not installation or execution authority.',
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    return { reportPath, brokerPath, executorPath };
  };
  const builds = [build('a'), build('b')] as const;
  const verifierPath = join(buildRoot, 'build-a/verify-handoff.mjs');
  if (hash(verifierPath) !== hash(join(buildRoot, 'build-b/verify-handoff.mjs')))
    throw new CleanupHandoffError('HANDOFF_BUILD_MISMATCH');
  const result = prepareCleanupHandoffDraft({ ...input, builds, verifierPath });
  writeFileSync(
    join(buildRoot, 'preparation-result.DRAFT.json'),
    JSON.stringify(result, null, 2) + '\n',
    { flag: 'wx' },
  );
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(
    (error instanceof CleanupHandoffError
      ? error.message
      : 'HANDOFF_IO_FAILED: build stopped; preserve partial staging and inspect the failed build separately.') +
      '\n',
  );
  process.exitCode = 2;
}
