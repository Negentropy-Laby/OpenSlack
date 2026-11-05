import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflowFile } from '../../packages/workflows/src/internal/workflow-file-loader.js';
import { CANDIDATE_SHA, digest, preparationStatus } from './evidence.js';
import { candidateRevision } from '../qualification/common.js';
import { readWorkflowEvidenceText } from '../../packages/workflows/src/internal/workflow-evidence-file.js';
import { CAMPAIGN_LIMITS, MAIN_CHAIN_PURPOSES } from './campaign.js';

const WORKFLOW_PATH = '.openslack/workflows/r-ext-go-qualification.mjs';

function committedInput(root: string, candidate: string, path: string): Buffer {
  const git = (...args: string[]) =>
    execFileSync(process.platform === 'win32' ? 'git.exe' : 'git', args, {
      cwd: root,
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
  const entry = git('ls-tree', '-z', candidate, '--', path).toString('utf8');
  if (!/^100(?:644|755) blob [0-9a-f]{40}\t/u.test(entry))
    throw new Error('Preparation input is not a regular committed file.');
  return git('show', candidate + ':' + path);
}

/** Repository-only inspection. Never touches App/provider configuration or credentials. */
export async function inspectPreparation(root: string, expectedCandidate: string) {
  if (!CANDIDATE_SHA.test(expectedCandidate)) throw new Error('Expected a full candidate commit.');
  const before = candidateRevision(root);
  const candidate = before.commit;
  if (candidate !== expectedCandidate)
    throw new Error('Candidate changed; do not inherit prior evidence.');
  const committedWorkflow = committedInput(root, candidate, WORKFLOW_PATH);
  const committedLock = committedInput(root, candidate, 'bun.lock');
  const workflowPath = join(root, WORKFLOW_PATH);
  const workflow = await loadWorkflowFile(workflowPath);
  if (
    workflow.sourceKind !== 'file' ||
    !workflow.sourceSnapshot ||
    workflow.meta.name !== 'r-ext-go-qualification'
  ) {
    throw new Error('The dedicated file-loader evidence is missing.');
  }
  const current = Buffer.from(await readWorkflowEvidenceText(workflowPath), 'utf8');
  const sourceHash = digest(current);
  if (!committedWorkflow.equals(current) || workflow.sourceSnapshot.rawHash !== sourceHash)
    throw new Error('Workflow source changed during inspection.');
  const lock = Buffer.from(await readWorkflowEvidenceText(join(root, 'bun.lock')), 'utf8');
  if (!committedLock.equals(lock))
    throw new Error('Candidate lock bytes changed during inspection.');
  const after = candidateRevision(root);
  if (after.commit !== candidate || after.tree !== before.tree)
    throw new Error('Candidate changed during inspection; do not inherit prior evidence.');
  return {
    schema: 'openslack.r_ext_preparation.v1' as const,
    candidate,
    tree: before.tree,
    clean: true,
    workflow: {
      path: WORKFLOW_PATH,
      sha256: sourceHash,
      bytes: current.length,
    },
    lockSha256: digest(lock),
    requiredAgentId: 'codex_qualification_rext',
    providerBinding: 'NOT_RUN',
    claim: 'NOT_EVALUATED',
    limits: { ...CAMPAIGN_LIMITS, mainChainCalls: MAIN_CHAIN_PURPOSES.length },
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
