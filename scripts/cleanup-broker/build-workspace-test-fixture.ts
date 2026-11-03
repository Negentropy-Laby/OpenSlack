// Test-only builder. No installed command accepts a substitute administrator contract.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build, write, type BunPlugin } from 'bun';
import {
  contractFixtureLoader,
  contractFixtureModule,
  contractModulePaths,
} from '../../packages/pr/src/__tests__/helpers/cleanup-workspace-contract-fixture.js';

interface FixtureBuild {
  name: 'production' | 'synthetic' | 'historical' | 'allowlist-probe';
  output: string;
  contract?: unknown;
}
const input = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
  sourceRoot: string;
  builds: FixtureBuild[];
};
for (const spec of input.builds) {
  const intercepted: string[] = [];
  const plugins: BunPlugin[] = [];
  if (spec.contract !== undefined) {
    const loader = contractFixtureLoader(input.sourceRoot, contractFixtureModule(spec.contract));
    plugins.push({
      name: 'TEST-ONLY-exact-administration-contract',
      setup(builder) {
        builder.onLoad({ filter: /cleanup-administration-contract[.](?:ts|js)$/ }, (request) => {
          const result = loader.onLoad(request);
          intercepted.push(request.path);
          return result;
        });
      },
    });
  }
  let entry = join(input.sourceRoot, 'scripts/cleanup-broker/administration/verify-workspace.ts');
  if (spec.name === 'allowlist-probe') {
    entry = 'cleanup-contract-fixture-probe';
    const [source, distribution] = contractModulePaths(input.sourceRoot);
    plugins.push({
      name: 'TEST-ONLY-both-contract-imports',
      setup(builder) {
        builder.onResolve({ filter: /^cleanup-contract-fixture-probe$/ }, () => ({
          path: entry,
          namespace: 'fixture-probe',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture-probe' }, () => ({
          contents: `import {CLEANUP_ADMIN_BINDINGS as source} from ${JSON.stringify(source.replaceAll('\\', '/'))};
import {CLEANUP_ADMIN_BINDINGS as distribution} from ${JSON.stringify(distribution.replaceAll('\\', '/'))};
console.log(JSON.stringify({source,distribution}));`,
          loader: 'ts',
        }));
      },
    });
  }
  try {
    const result = await build({ entrypoints: [entry], target: 'node', format: 'esm', plugins });
    if (!result.success) throw new AggregateError(result.logs, 'fixture build failed');
    if (result.outputs.length !== 1) throw new Error('unexpected fixture artifact count');
    await write(spec.output, result.outputs[0]!);
    await write(spec.output + '.build.json', JSON.stringify({ name: spec.name, intercepted }));
  } catch (error) {
    console.error(`WORKSPACE_FIXTURE_BUILD_FAILED: ${spec.name}`);
    throw error;
  }
}
