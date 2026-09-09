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
await import('./generator.mts');
