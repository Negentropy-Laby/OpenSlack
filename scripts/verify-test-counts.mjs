import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--update'))
  throw new Error('Usage: verify-test-counts.mjs [--update]');
// CLI list output omits platform-skipped cases. Collect the full declared inventory
// through Vitest's API so Windows, Linux and macOS verify the same authority.
process.env.TEST = 'true';
process.env.VITEST = 'true';
process.env.NODE_ENV ??= 'test';
const { createVitest } = await import('vitest/node');
const vitest = await createVitest('test', { root, run: true, watch: false, reporters: [] });
try {
  const { testModules, unhandledErrors } = await vitest.collect();
  if (
    !testModules.length ||
    unhandledErrors.length ||
    testModules.some(
      (module) =>
        module.errors().length ||
        [...module.children.allSuites()].some((suite) => suite.errors().length),
    )
  )
    throw new Error('Vitest did not return a complete test collection.');
  const tests = testModules.flatMap((module) =>
    [...module.children.allTests()].map((test) => ({
      file: module.moduleId,
      projectName: test.project.name,
    })),
  );
  if (!tests.length || tests.some((test) => !test.file || !test.projectName))
    throw new Error('Collected tests are missing their file or project identity.');
  const path = join(root, '.openslack/modules.yaml');
  let source = await readFile(path, 'utf8');
  const document = parseDocument(source);
  if (document.errors.length) throw new Error('Module registry could not be parsed.');
  const registry = document.toJS();
  const changes = [];
  const edits = [];
  function count(pointer, expected) {
    const actual = document.getIn(pointer);
    if (actual !== expected) {
      changes.push(`${pointer.join('.')}: ${actual} -> ${expected}`);
      const node = document.getIn(pointer, true);
      if (!node?.range || typeof actual !== 'number')
        throw new Error('Missing numeric module count.');
      edits.push({ start: node.range[0], end: node.range[1], value: String(expected) });
    }
  }
  const files = (tests) => new Set(tests.map((test) => test.file)).size;
  count(['vitest_tests'], tests.length);
  count(['vitest_files'], files(tests));
  for (const [index, module] of registry.modules.entries()) {
    const relevant = tests.filter((test) => module.packages.includes(test.projectName));
    if (!relevant.length) throw new Error(`No tests collected for module ${module.id}.`);
    count(['modules', index, 'tests'], relevant.length);
    count(['modules', index, 'test_files'], files(relevant));
  }
  if (changes.length && process.argv[2] !== '--update')
    throw new Error(
      `Vitest test-count drift; run node scripts/verify-test-counts.mjs --update and regenerate status.\n${changes.join('\n')}`,
    );
  if (changes.length) {
    for (const edit of edits.sort((a, b) => b.start - a.start))
      source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
    await writeFile(path, source);
  }
  console.log(
    `Vitest collected ${tests.length} declared cases (including skipped) in ${files(tests)} files; module counts ${changes.length ? 'updated' : 'verified'}.`,
  );
} finally {
  await vitest.close();
}
