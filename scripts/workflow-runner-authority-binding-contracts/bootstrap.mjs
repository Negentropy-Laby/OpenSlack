import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { validateControlSequences, sequenceSource, sequenceTS } from './control-sequences.ts';

const root = new URL('../../', import.meta.url);
const rules = validateControlSequences(
  JSON.parse(await readFile(new URL(sequenceSource, root), 'utf8')),
);
register('./sequence-loader.mjs', import.meta.url, {
  data: { target: new URL(sequenceTS, root).href, rules },
});
export const { generate, check } = await import('./generator.mts');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? '--generate';
  if (command === '--generate' || command === 'generate') await generate();
  else if (command === '--check' || command === 'check') await check();
  else throw new Error('Usage: index.ts [--generate|--check]');
}
