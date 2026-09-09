import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A fresh loader supplies canonical rules before validators are imported, so
// generation can repair even a missing projection without modifying its inputs.
const entry = fileURLToPath(new URL('./bootstrap.mjs', import.meta.url));
const result = spawnSync('node', ['--import', 'tsx', entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
