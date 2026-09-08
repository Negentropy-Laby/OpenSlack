// Run with: node --import tsx scripts/bench-workflow-reads.mjs [source-checkout]
// Compare both checkouts on the same host. This writes only its temporary fixture.
import nodeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';

const source = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const fs = nodeFs.promises;
const counts = {};
let measuring = false;
for (const [surface, methods] of [
  [fs, ['lstat', 'realpath', 'readdir', 'open', 'readFile']],
  [
    nodeFs,
    ['existsSync', 'lstatSync', 'openSync', 'fstatSync', 'readSync', 'closeSync', 'opendirSync'],
  ],
]) {
  for (const method of methods) {
    const original = surface[method];
    surface[method] = function (...args) {
      if (measuring) counts[method] = (counts[method] ?? 0) + 1;
      return Reflect.apply(original, this, args);
    };
  }
}
syncBuiltinESMExports();
const { createWorkflowRunReadQuery } = await import(
  pathToFileURL(join(source, 'packages/workflows/src/workflow-run-read-query.ts')).href
);
const { createWorkflowRunRouteJournal } = await import(
  pathToFileURL(join(source, 'packages/workflows/src/workflow-run-routing.ts')).href
);
const rows = [];
for (const [runs, quarantine] of [
  [4, 8],
  [12, 8],
  [12, 80],
  [48, 800],
]) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'openslack-read-benchmark-'));
  try {
    await createWorkflowRunRouteJournal(root).initialize();
    const base = join(root, '.openslack.local', 'workflows');
    for (let i = 0; i < runs; i++) {
      const runId = `run.${i}`,
        directory = join(base, 'runs', runId);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        join(directory, 'meta.json'),
        JSON.stringify({
          runId,
          workflowName: 'workflow-bench',
          mode: 'execute',
          manifestHash: 'a'.repeat(64),
          args: {},
          startedAt: '2026-09-08T00:00:00.000Z',
        }),
      );
      await fs.writeFile(
        join(directory, 'status.json'),
        JSON.stringify({
          runId,
          status: 'paused',
          phases: [],
          updatedAt: '2026-09-08T00:00:00.000Z',
        }),
      );
    }
    for (let i = 0; i < quarantine; i++)
      await fs.writeFile(
        join(
          base,
          'routes',
          'quarantine',
          createHash('sha256').update(`other.${i}`).digest('hex') + '.json.incident',
        ),
        'retained incident',
      );
    for (const key of Object.keys(counts)) delete counts[key];
    measuring = true;
    const started = performance.now(),
      query = createWorkflowRunReadQuery(root);
    await query.list();
    const list = await query.list();
    for (const run of list)
      await query.progress(run.runId, { loadWorkflowManifest: false, loadCostConfig: false });
    const milliseconds = performance.now() - started;
    measuring = false;
    if (list.length !== runs || list.diagnostics.length)
      throw new Error('Benchmark lost healthy runs.');
    rows.push({
      runs,
      quarantine,
      milliseconds: Math.round(milliseconds * 100) / 100,
      calls: { ...counts },
    });
  } finally {
    measuring = false;
    await fs.rm(root, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify(
    {
      platform: process.platform,
      node: process.version,
      source,
      gitHead: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      rows,
    },
    null,
    2,
  ),
);
