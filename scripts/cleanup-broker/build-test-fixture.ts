// Never installed: test-only bundle explicitly replaces network resources and
// maps the fixed Git command to an isolated real bare repository.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = process.cwd();
const resources = resolve(root, 'packages/pr/src/__tests__/fixtures/cleanup-executor-resources.ts');
const output = process.argv[2]!;
const result = await Bun.build({
  entrypoints: [resolve(root, 'packages/pr/src/internal/cleanup-broker-executor-entry.ts')],
  target: 'node',
  format: 'esm',
  packages: 'bundle',
  plugins: [
    {
      name: 'TEST-ONLY-cleanup-resources',
      setup(build) {
        build.onResolve({ filter: /^undici$/ }, () => ({
          path: resolve(root, 'packages/pr/src/__tests__/fixtures/cleanup-executor-network.ts'),
        }));
        build.onLoad({ filter: /cleanup-broker-executor\.ts$/ }, async ({ path }) => {
          let contents = await readFile(path, 'utf8');
          contents = contents.replace(
            '} catch {\n    // Do not synthesize',
            '} catch (fixtureError) {\n    console.error(fixtureError);\n    // Do not synthesize',
          );
          for (const name of [
            'getDefaultBranch',
            'isBranchProtected',
            'listOpenPRsForBranch',
            'claimRefPresent',
          ])
            contents = contents.replace(`  ${name},\n`, '');
          contents = contents.replace(
            "import { fetchPRDetails } from '../fetch.js';",
            `import { fetchPRDetails, getDefaultBranch, isBranchProtected, listOpenPRsForBranch, claimRefPresent } from ${JSON.stringify(resources)};`,
          );
          return { contents, loader: 'ts' };
        });
        build.onLoad({ filter: /cleanup-broker-transport\.(?:ts|js)$/ }, async ({ path }) => {
          let contents = await readFile(path, 'utf8');
          contents = contents.replace(
            "import { spawnSync } from 'node:child_process';",
            `import { spawnSync as originalSpawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
function spawnSync(command, args, options) {
 const mapped = args.map(value => value === 'https://github.com/example/qualification.git' ? process.env.CLEANUP_FIXTURE_BARE : value);
 if(args.includes('push')) appendFileSync(process.env.CLEANUP_FIXTURE_LOG, 'push\\n');
 const result = originalSpawn('/usr/bin/git', mapped, { ...options, cwd: process.env.CLEANUP_FIXTURE_WORK, env: { ...options.env, GIT_EXEC_PATH: '/usr/lib/git-core' } });
 if(args.includes('push') && process.env.CLEANUP_FIXTURE_UNKNOWN === '1') return { ...result, status: null, error: Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' }) };
 return result;
}`,
          );
          return { contents, loader: 'ts' };
        });
      },
    },
  ],
});
if (!result.success || result.outputs.length !== 1) throw new Error(String(result.logs));
await Bun.write(output, result.outputs[0]!);
