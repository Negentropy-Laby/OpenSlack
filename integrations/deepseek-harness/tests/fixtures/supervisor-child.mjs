// A benign three-generation process fixture. Never imported by product entries.
import { spawn } from 'node:child_process';
const mode = process.argv[2] ?? 'normal';
console.log(JSON.stringify({ fixturePid: process.pid, mode }));
if (mode === 'forge') {
  console.log(JSON.stringify({ protocol: 'openslack.windows_job.v1', kind: 'exit-receipt', jobEmpty: true }));
}
if (mode === 'flood') {
  process.stderr.write('diagnostic '.repeat(16_384));
  process.stdout.write('output '.repeat(16_384));
}
let child;
if (mode === 'tree' || mode === 'root-exit' || mode === 'crash-tree' || mode === 'middle' || mode === 'stubborn-middle') {
  const childMode = mode === 'tree' ? 'middle' : mode === 'middle' ? 'leaf' : mode === 'root-exit' || mode === 'crash-tree' ? 'stubborn-middle' : 'stubborn-leaf';
  child = spawn(process.execPath, [import.meta.filename, childMode], { stdio: ['pipe', 'inherit', 'inherit'],
    detached: mode === 'root-exit' || mode === 'crash-tree' || mode.startsWith('stubborn') });
  if (mode === 'root-exit') setTimeout(() => process.exit(0), 100);
}
const keepAlive = setInterval(() => {}, 1000);
let inputBytes = 0;
if (mode !== 'blocked-input') {
  process.stdin.on('data', bytes => { inputBytes += bytes.length; });
  process.stdin.resume();
}
process.stdin.on('end', () => {
  if (mode.startsWith('stubborn') || mode === 'force' || mode === 'crash-tree' || mode === 'blocked-input') return;
  if (mode === 'tail') console.log(JSON.stringify({ receivedBytes: inputBytes }));
  if (child) {
    child.once('close', () => { clearInterval(keepAlive); });
    child.stdin.end();
  } else clearInterval(keepAlive);
});
