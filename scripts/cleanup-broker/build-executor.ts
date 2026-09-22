import { mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
if (args.length !== 2 || !['--outdir', '--internal-single-build'].includes(args[0]!) || !args[1])
  throw new Error(
    'Usage: bun scripts/cleanup-broker/build-executor.ts --outdir <artifact-directory>',
  );
if (args[0] === '--outdir') {
  // Private relative dist imports must be regenerated from this candidate, not
  // whatever a previous checkout happened to leave behind.
  const compiler = Bun.spawn(
    [process.execPath, 'node_modules/typescript/bin/tsc', '-b', 'packages/pr', '--force'],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await compiler.exited) !== 0) throw new Error('CLEANUP_EXECUTOR_TYPECHECK_FAILED');
}
const build = async () => {
  const result = await Bun.build({
    entrypoints: [resolve('packages/pr/src/internal/cleanup-broker-executor-entry.ts')],
    target: 'node',
    format: 'esm',
    splitting: false,
    minify: false,
    sourcemap: 'none',
    packages: 'bundle',
    // Undici uses __filename only to augment error stacks. Do not embed the
    // checkout directory in the sealed artifact; this is a logical filename,
    // not a filesystem or credential lookup path.
    define: { __filename: JSON.stringify('openslack-cleanup-executor.mjs') },
  });
  if (!result.success || result.outputs.length !== 1)
    throw new Error('CLEANUP_EXECUTOR_BUILD_FAILED');
  return Buffer.from(await result.outputs[0]!.arrayBuffer());
};
if (args[0] === '--internal-single-build') {
  await writeFile(args[1], await build(), { flag: 'wx', mode: 0o644 });
  process.exit(0);
}
// Separate processes and empty output directories: no in-process bundler cache
// can make the second build appear reproducible. Inputs remain the caller's
// candidate checkout; this does not claim an independently clean Git checkout.
const directories = await Promise.all([
  mkdtemp(join(tmpdir(), 'cleanup-build-a-')),
  mkdtemp(join(tmpdir(), 'cleanup-build-b-')),
]);
const bytes: Buffer[] = [];
for (const directory of directories) {
  const path = join(directory, 'executor.mjs');
  const child = Bun.spawn([process.execPath, import.meta.path, '--internal-single-build', path], {
    stdout: 'ignore',
    stderr: 'inherit',
  });
  if ((await child.exited) !== 0) throw new Error('CLEANUP_EXECUTOR_BUILD_FAILED');
  bytes.push(await readFile(path));
}
const [first, second] = bytes as [Buffer, Buffer];
if (!first.equals(second)) throw new Error('CLEANUP_EXECUTOR_BUILD_NOT_REPRODUCIBLE');
const output = resolve(args[1]);
await mkdir(output, { recursive: true });
await writeFile(join(output, 'executor.mjs'), first, { mode: 0o644 });
console.log(
  JSON.stringify({
    artifact: join(output, 'executor.mjs'),
    sha256: createHash('sha256').update(first).digest('hex'),
    bytes: first.length,
    reproducible: true,
    independentProcesses: true,
    buildRuntime: process.version,
    bundler: Bun.version,
  }),
);
