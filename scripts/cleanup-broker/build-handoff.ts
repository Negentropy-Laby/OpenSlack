import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CleanupHandoffError,
  assertCleanupHandoffStaging,
  assertCleanupHandoffRuntime,
  readCleanupHandoffInputFile,
  prepareCleanupHandoffDraft,
  CLEANUP_HANDOFF_SCHEMAS,
  cleanupHandoffToolchain,
  assertCleanupHandoffToolchain,
  assertCleanupHandoffObjects,
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
  assertCleanupHandoffToolchain(tools, cleanupHandoffToolchain(source));
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
    assertCleanupHandoffObjects(resolve(checkout, objectFiles));
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
    // The Broker-only client and the administrator tooling are bundled the same
    // way, so both carry the same two-independent-builds byte-identity proof.
    const bundleTool = (entry: string, outfile: string) => {
      const result = Bun.spawnSync(
        [
          process.execPath,
          'build',
          `scripts/cleanup-broker/${entry}`,
          '--target=node',
          '--format=esm',
          '--outfile',
          join(artifacts, outfile),
        ],
        { cwd: checkout, stdout: 'pipe', stderr: 'pipe' },
      );
      if (result.exitCode !== 0) throw new CleanupHandoffError('HANDOFF_BUILD_MISMATCH');
    };
    bundleTool('client.ts', 'cleanup-client.mjs');
    bundleTool('admin-upgrade.ts', 'admin-upgrade.mjs');
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
          schema: CLEANUP_HANDOFF_SCHEMAS.build,
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
            'bun build scripts/cleanup-broker/client.ts --target=node --format=esm --outfile <artifact-directory>/cleanup-client.mjs',
            'bun build scripts/cleanup-broker/admin-upgrade.ts --target=node --format=esm --outfile <artifact-directory>/admin-upgrade.mjs',
          ],
          broker: { sha256: hash(brokerPath), bytes: statSync(brokerPath).size },
          executor: { sha256: hash(executorPath), bytes: statSync(executorPath).size },
          // Every tool this build produced is proven by digest and size, so the
          // package's tools cannot be completed by a file no build bound.
          verifier: {
            sha256: hash(join(artifacts, 'verify-handoff.mjs')),
            bytes: statSync(join(artifacts, 'verify-handoff.mjs')).size,
          },
          client: {
            sha256: hash(join(artifacts, 'cleanup-client.mjs')),
            bytes: statSync(join(artifacts, 'cleanup-client.mjs')).size,
          },
          adminTool: {
            sha256: hash(join(artifacts, 'admin-upgrade.mjs')),
            bytes: statSync(join(artifacts, 'admin-upgrade.mjs')).size,
          },
          scope: 'Clean build and byte integrity only; not installation or execution authority.',
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    return {
      reportPath,
      brokerPath,
      executorPath,
      verifierPath: join(artifacts, 'verify-handoff.mjs'),
      clientPath: join(artifacts, 'cleanup-client.mjs'),
      adminToolPath: join(artifacts, 'admin-upgrade.mjs'),
    };
  };
  const builds = [build('a'), build('b')] as const;
  // Every bundled tool must be byte-identical across the two independent builds.
  const identicalTools = ['verify-handoff.mjs', 'cleanup-client.mjs', 'admin-upgrade.mjs'];
  for (const tool of identicalTools) {
    if (hash(join(buildRoot, 'build-a', tool)) !== hash(join(buildRoot, 'build-b', tool)))
      throw new CleanupHandoffError('HANDOFF_BUILD_MISMATCH');
  }
  const verifierPath = join(buildRoot, 'build-a/verify-handoff.mjs');
  const clientPath = join(buildRoot, 'build-a/cleanup-client.mjs');
  const adminToolPath = join(buildRoot, 'build-a/admin-upgrade.mjs');
  const clientDocPath = join(source, 'services/cleanup-broker/client.md');
  const result = prepareCleanupHandoffDraft({
    ...input,
    builds,
    verifierPath,
    clientPath,
    adminToolPath,
    clientDocPath,
  });
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
