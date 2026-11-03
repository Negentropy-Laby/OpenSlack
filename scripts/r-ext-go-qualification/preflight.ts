import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflowFile } from '../../packages/workflows/src/internal/workflow-file-loader.js';
import { CANDIDATE_SHA, digest, preparationStatus } from './evidence.js';

/** Repository-only inspection. Never touches App/provider configuration or credentials. */
export async function inspectPreparation(root: string, expectedCandidate: string) {
  if (!CANDIDATE_SHA.test(expectedCandidate)) throw new Error('Expected a full candidate commit.');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
  const candidate = git('rev-parse', 'HEAD');
  if (candidate !== expectedCandidate)
    throw new Error('Candidate changed; do not inherit prior evidence.');
  const workflowPath = join(root, '.openslack/workflows/r-ext-go-qualification.mjs');
  const source = await readFile(workflowPath);
  const workflow = await loadWorkflowFile(workflowPath);
  if (
    workflow.sourceKind !== 'file' ||
    !workflow.sourceSnapshot ||
    workflow.meta.name !== 'r-ext-go-qualification'
  ) {
    throw new Error('The dedicated file-loader evidence is missing.');
  }
  const current = await readFile(workflowPath);
  if (!source.equals(current) || workflow.sourceSnapshot.rawHash !== digest(current))
    throw new Error('Workflow source changed during inspection.');
  return {
    schema: 'openslack.r_ext_preparation.v1' as const,
    candidate,
    tree: git('rev-parse', 'HEAD^{tree}'),
    clean: git('status', '--porcelain') === '',
    workflow: {
      path: '.openslack/workflows/r-ext-go-qualification.mjs',
      sha256: digest(current),
      bytes: current.length,
    },
    lockSha256: digest(await readFile(join(root, 'bun.lock'))),
    requiredAgentId: 'codex_qualification_rext',
    providerBinding: 'NOT_RUN',
    claim: 'NOT_EVALUATED',
    limits: { attempts: 4, tokensPerAttempt: 8192, totalTokens: 32768, mainChainCalls: 2 },
    ...preparationStatus(),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--candidate') {
    process.stderr.write(
      'Usage: bun scripts/r-ext-go-qualification/preflight.ts --candidate <full-commit>\n',
    );
    process.exitCode = 1;
  } else {
    inspectPreparation(process.cwd(), args[1]!)
      .then((report) => {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        // A valid preparation inspection is not live readiness.
        process.exitCode = report.liveExecutionEnabled ? 0 : 2;
      })
      .catch(() => {
        process.stderr.write(
          'R-EXT preparation inspection failed closed; verify candidate and source evidence.\n',
        );
        process.exitCode = 1;
      });
  }
}
