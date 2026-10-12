import {
  readCleanupArtifactFile,
  digestCleanupBoundedFile,
  CLEANUP_INSTALL_LAYOUT,
  assertCleanupHandoffStaging,
  assertCleanupHandoffRuntime,
  readCleanupHandoffInputFile,
  CLEANUP_HANDOFF_SCHEMAS,
  cleanupHandoffToolchain,
  assertCleanupHandoffToolchain,
  assertCleanupHandoffObjects,
} from '@openslack/pr/cleanup-administration-internal';
import { isSensitiveCleanupInput } from '@openslack/pr/cleanup-administration-internal';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { CleanupHandoffError, prepareCleanupHandoffDraft } from '@openslack/pr';
import type { CleanupHandoffBuildInput, PrepareCleanupHandoffDraftInput } from '@openslack/pr';
import { CLEANUP_ADMIN_TOOLKIT_FILES, prepareCleanupAdminToolkit } from '@openslack/pr';

// Orchestrates two clean builds; all draft construction/verification belongs to @openslack/pr.
type BuildInput = Omit<PrepareCleanupHandoffDraftInput, 'builds' | 'verifierPath' | 'now'> & {
  buildDirectory: string;
  /** Source-only proof does not claim this Node binary is installed on a target. */
  nodePath?: string;
};
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const captureArtifact = (path: string) => {
  const raw = readCleanupArtifactFile(path, 256 * 1024 * 1024);
  return {
    raw,
    proof: { sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length },
  };
};
const buildProofs = new Map<string, Record<string, { sha256: string; bytes: number }>>();
const administratorBuilds: { reportPath: string; toolDirectory: string }[] = [];
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
  const sourceOnly = args[0] === '--source-only';
  if (sourceOnly) args.shift();
  if (args.length !== 2 || args[0] !== '--input' || !args[1])
    throw new CleanupHandoffError('HANDOFF_INPUT_INVALID');
  const input = readCleanupHandoffInputFile(args[1]) as BuildInput;
  if ('now' in input || process.platform !== 'linux' || !/^[a-f0-9]{40}$/.test(input.candidateHead))
    throw new CleanupHandoffError('HANDOFF_INPUT_INVALID');
  const { sourceRoot: source } = assertCleanupHandoffStaging({
    ...input,
    outputDirectory: sourceOnly ? input.buildDirectory : input.outputDirectory,
  });
  const { outputDirectory: buildRoot } = assertCleanupHandoffStaging({
    ...input,
    outputDirectory: input.buildDirectory,
  });
  if (!sourceOnly && resolve(input.outputDirectory) === buildRoot)
    throw new CleanupHandoffError('HANDOFF_PATH_UNSAFE');
  if (
    sourceOnly &&
    (typeof input.nodePath !== 'string' ||
      !isAbsolute(input.nodePath) ||
      /[\r\n\0]/.test(input.nodePath) ||
      isSensitiveCleanupInput(input.nodePath, source))
  )
    throw new CleanupHandoffError('HANDOFF_INPUT_INVALID');
  const node = sourceOnly
    ? realpathSync.native(input.nodePath!)
    : assertCleanupHandoffRuntime(input);
  const nodeBound = CLEANUP_INSTALL_LAYOUT.find((entry) => entry.artifact === 'node')!.maxBytes;
  const sourceNodeProof = sourceOnly ? digestCleanupBoundedFile(node, nodeBound) : undefined;
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
    run('git', ['clone', '--quiet', '--no-local', '--no-checkout', source, checkout], source);
    run('git', ['checkout', '--quiet', '--detach', input.candidateHead], checkout);
    if (run('git', ['status', '--porcelain'], checkout))
      throw new CleanupHandoffError('HANDOFF_SOURCE_DIRTY');
    // --no-local prohibits shared object hardlinks; verify the resulting store too.
    const objectFiles = run('git', ['rev-parse', '--git-path', 'objects'], checkout);
    assertCleanupHandoffObjects(resolve(checkout, objectFiles));
    run(process.execPath, ['install', '--frozen-lockfile', '--ignore-scripts'], checkout);
    run(
      'python3',
      ['-I', '-B', 'scripts/cleanup-broker/generate-administration-contract.py', '--check'],
      checkout,
    );
    run(
      process.execPath,
      ['x', 'tsc', '--build', 'packages/pr/tsconfig.json', 'packages/runtime/tsconfig.json'],
      checkout,
    );
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
    const toolDirectory = join(artifacts, 'admin-toolkit');
    mkdirSync(toolDirectory);
    for (const name of CLEANUP_ADMIN_TOOLKIT_FILES) {
      const sourceName =
        name.endsWith('.mjs') && name !== 'qualification-fixtures.mjs'
          ? name.replace(/\.mjs$/, '.ts')
          : name;
      const entry = join(checkout, 'scripts/cleanup-broker/administration', sourceName);
      if (name.endsWith('.mjs')) {
        const result = Bun.spawnSync(
          [
            process.execPath,
            'build',
            entry,
            '--target=node',
            '--format=esm',
            '--outfile',
            join(toolDirectory, name),
          ],
          { cwd: checkout, stdout: 'pipe', stderr: 'pipe' },
        );
        if (result.exitCode !== 0) throw new CleanupHandoffError('HANDOFF_BUILD_MISMATCH');
      } else {
        writeFileSync(join(toolDirectory, name), readCleanupArtifactFile(entry, 2 * 1024 * 1024), {
          flag: 'wx',
          mode: 0o644,
        });
      }
    }
    const administratorReport = join(artifacts, 'admin-toolkit-build-report.json');
    writeFileSync(
      administratorReport,
      JSON.stringify(
        {
          schema: 'openslack.cleanup_admin_toolkit_build_report.v1',
          candidateHead: input.candidateHead,
          checkout,
          checkoutCleanAfterBuild: run('git', ['status', '--porcelain'], checkout) === '',
          independentCloneNoHardlinks: true,
          tools: { ...tools, git: run('git', ['--version'], checkout) },
          lockfileSHA256: hash(join(checkout, 'bun.lock')),
          commands: [
            'git clone --no-local --no-checkout <source> <checkout>',
            `git checkout --detach ${input.candidateHead}`,
            'bun install --frozen-lockfile --ignore-scripts',
            'python3 -I -B scripts/cleanup-broker/generate-administration-contract.py --check',
            'bun x tsc --build packages/pr/tsconfig.json packages/runtime/tsconfig.json',
            ...CLEANUP_ADMIN_TOOLKIT_FILES.filter((name) => name.endsWith('.mjs')).map(
              (name) =>
                `bun build scripts/cleanup-broker/administration/${name === 'qualification-fixtures.mjs' ? name : name.replace(/\.mjs$/, '.ts')} --target=node --format=esm --outfile <tool-directory>/${name}`,
            ),
            'readCleanupArtifactFile and exclusive writeFileSync copy Python/shared/README bytes from the clean candidate checkout',
          ],
          artifacts: CLEANUP_ADMIN_TOOLKIT_FILES.map((name) => ({
            path: name,
            ...captureArtifact(join(toolDirectory, name)).proof,
          })),
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o644 },
    );
    administratorBuilds.push({ reportPath: administratorReport, toolDirectory });
    const brokerBuildMetadata = run('go', ['version', '-m', brokerPath], checkout).split('\n');
    if (
      !brokerBuildMetadata.some((line) => line.includes(`vcs.revision=${input.candidateHead}`)) ||
      !brokerBuildMetadata.some((line) => line.includes('vcs.modified=false'))
    )
      throw new CleanupHandoffError('HANDOFF_BUILD_MISMATCH');
    const captured = Object.fromEntries(
      [
        'cleanup-broker',
        'executor.mjs',
        'verify-handoff.mjs',
        'cleanup-client.mjs',
        'admin-upgrade.mjs',
      ].map((name) => [name, captureArtifact(join(artifacts, name)).proof]),
    );
    buildProofs.set(id, captured);
    const reportPath = join(artifacts, 'build-report.json');
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          // The v2 profile: this build proves verifier, client and admin tool too.
          schema: CLEANUP_HANDOFF_SCHEMAS.buildV2,
          candidateHead: input.candidateHead,
          checkout,
          checkoutCleanAfterBuild: run('git', ['status', '--porcelain'], checkout) === '',
          independentCloneNoHardlinks: true,
          tools,
          brokerBuildMetadata,
          lockfileSHA256: hash(join(checkout, 'bun.lock')),
          goModuleSHA256: hash(join(checkout, 'services/cleanup-broker/go.mod')),
          commands: [
            'git clone --no-local --no-checkout <source> <checkout>',
            `git checkout --detach ${input.candidateHead}`,
            'bun install --frozen-lockfile --ignore-scripts',
            'python3 -I -B scripts/cleanup-broker/generate-administration-contract.py --check',
            'bun x tsc --build packages/pr/tsconfig.json packages/runtime/tsconfig.json',
            'GOWORK=off CGO_ENABLED=0 go build -trimpath -buildvcs=true -o <artifact-directory>/cleanup-broker ./cmd/cleanup-broker',
            'bun scripts/cleanup-broker/build-executor.ts --outdir <artifact-directory>',
            'bun build scripts/cleanup-broker/verify-handoff.ts --target=node --format=esm --outfile <artifact-directory>/verify-handoff.mjs',
            'bun build scripts/cleanup-broker/client.ts --target=node --format=esm --outfile <artifact-directory>/cleanup-client.mjs',
            'bun build scripts/cleanup-broker/admin-upgrade.ts --target=node --format=esm --outfile <artifact-directory>/admin-upgrade.mjs',
          ],
          broker: captured['cleanup-broker'],
          executor: captured['executor.mjs'],
          verifier: captured['verify-handoff.mjs'],
          client: captured['cleanup-client.mjs'],
          adminTool: captured['admin-upgrade.mjs'],
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
  const identicalTools = [
    'cleanup-broker',
    'executor.mjs',
    'verify-handoff.mjs',
    'cleanup-client.mjs',
    'admin-upgrade.mjs',
  ];
  // A separate final read detects drift since the report. Its owned bytes and
  // digest are also the source-only proof; there is no third file/hash pass.
  const finalProofs: Record<string, { sha256: string; bytes: number }> = {};
  for (const tool of identicalTools) {
    const a = captureArtifact(join(buildRoot, 'build-a', tool)),
      b = captureArtifact(join(buildRoot, 'build-b', tool));
    if (
      !a.raw.equals(b.raw) ||
      a.proof.sha256 !== buildProofs.get('a')![tool]!.sha256 ||
      b.proof.sha256 !== buildProofs.get('b')![tool]!.sha256
    )
      throw new CleanupHandoffError('HANDOFF_BUILD_MISMATCH');
    finalProofs[tool] = a.proof;
  }
  const administratorToolkit = prepareCleanupAdminToolkit({
    sourceRoot: source,
    candidateHead: input.candidateHead,
    outputDirectory: join(buildRoot, 'administrator-toolkit'),
    builds: [administratorBuilds[0]!, administratorBuilds[1]!],
  });
  if (sourceOnly) {
    const finalNodeProof = digestCleanupBoundedFile(node, nodeBound);
    if (
      finalNodeProof.sha256 !== sourceNodeProof!.sha256 ||
      finalNodeProof.bytes !== sourceNodeProof!.bytes
    )
      throw new CleanupHandoffError('HANDOFF_SOURCE_CHANGED');
    const proof = {
      schema: 'openslack.cleanup_source_build_proof.v1',
      candidateHead: input.candidateHead,
      tools,
      sourceNodeSHA256: finalNodeProof.sha256,
      builds,
      artifacts: finalProofs,
      administratorToolkit,
      packageCreated: false,
      targetEvidenceVerified: false,
      installationAuthorized: false,
      executionAuthorized: false,
    };
    writeFileSync(
      join(buildRoot, 'source-build-proof.json'),
      JSON.stringify(proof, null, 2) + '\n',
      { flag: 'wx' },
    );
    process.stdout.write(JSON.stringify(proof, null, 2) + '\n');
  } else {
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
    const publishedResult = { ...result, administratorToolkit };
    writeFileSync(
      join(buildRoot, 'preparation-result.DRAFT.json'),
      JSON.stringify(publishedResult, null, 2) + '\n',
      { flag: 'wx' },
    );
    process.stdout.write(JSON.stringify(publishedResult, null, 2) + '\n');
  }
} catch (error) {
  process.stderr.write(
    (error instanceof CleanupHandoffError
      ? error.message
      : 'HANDOFF_IO_FAILED: build stopped; preserve partial staging and inspect the failed build separately.') +
      '\n',
  );
  process.exitCode = 2;
}
