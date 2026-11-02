#!/usr/bin/env bash
# CI preparation only: original dependency, download store, never runtime authority.
set -euo pipefail
openslack_ci_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
openslack_ci_harness="$openslack_ci_root/.openslack.local/ci/harness-original"
openslack_ci_store="$openslack_ci_root/.openslack.local/ci/pnpm-store"
cd -- "$openslack_ci_harness"
openslack_harness_expected=$(node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { HARNESS_COMPATIBILITY_SHA } = await import(pathToFileURL(process.argv[1]));
  process.stdout.write(HARNESS_COMPATIBILITY_SHA);
' "$openslack_ci_root/integrations/deepseek-harness/compatibility-witness.mjs")
test "$(git rev-parse HEAD)" = "$openslack_harness_expected"
capture_harness_inputs() {
  node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const files = git('ls-files', '-z').split('\0').filter(Boolean).sort().map(path =>
  [path, lstatSync(path).mode, sha(lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path))]);
console.log(sha(JSON.stringify([git('rev-parse', 'HEAD'), git('ls-files', '--stage'),
  git('for-each-ref', '--format=%(refname) %(objectname)'), files])));
NODE
}
openslack_harness_before=$(capture_harness_inputs)
npm install --global pnpm@11.28.5 --ignore-scripts
pnpm install --frozen-lockfile --store-dir "$openslack_ci_store" --side-effects-cache=false --verify-store-integrity=true
pnpm run build:artifacts
pnpm run build:check
test "$openslack_harness_before" = "$(capture_harness_inputs)"
git diff --exit-code
git diff --cached --exit-code
test "$(git rev-parse HEAD)" = "$openslack_harness_expected"
