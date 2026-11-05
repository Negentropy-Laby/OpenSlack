import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflowFile } from '../../packages/workflows/src/internal/workflow-file-loader.js';
import { CANDIDATE_SHA, digest, preparationStatus } from './evidence.js';
import { candidateRevision } from '../qualification/common.js';
import { readWorkflowEvidenceText } from '../../packages/workflows/src/internal/workflow-evidence-file.js';
import { CAMPAIGN_LIMITS, MAIN_CHAIN_PURPOSES } from './campaign.js';

const WORKFLOW_PATH = '.openslack/workflows/r-ext-go-qualification.mjs';

const COMMITTED_INPUT_LIMIT = 2 * 1024 * 1024;

function committedInputs(root: string, candidate: string, paths: readonly string[]): Buffer[] {
  const git = (args: string[], input?: string) =>
    execFileSync(process.platform === 'win32' ? 'git.exe' : 'git', args, {
      cwd: root,
      timeout: 10_000,
      windowsHide: true,
      input,
      maxBuffer: paths.length * COMMITTED_INPUT_LIMIT + 1024,
    });
  const invalid = (): never => {
    throw new Error('Preparation inputs are not exact bounded regular committed blobs.');
  };
  const tree = git(['ls-tree', '-z', candidate, '--', ...paths]).toString('utf8');
  if (!tree.endsWith('\0')) return invalid();
  const entries = tree.slice(0, -1).split('\0');
  if (entries.length !== paths.length) return invalid();
  const objects = new Map<string, string>();
  for (const entry of entries) {
    const match = /^100(?:644|755) blob ([0-9a-f]{40})\t(.+)$/u.exec(entry);
    if (!match || !paths.includes(match[2]!) || objects.has(match[2]!)) return invalid();
    objects.set(match[2]!, match[1]!);
  }
  const ids = paths.map((path) => objects.get(path) ?? invalid());
  const batch = git(['cat-file', '--batch'], ids.join('\n') + '\n');
  const results: Buffer[] = [];
  let offset = 0;
  for (const id of ids) {
    const headerEnd = batch.indexOf(10, offset);
    if (headerEnd < 0) return invalid();
    const header = /^([0-9a-f]{40}) blob (0|[1-9][0-9]*)$/u.exec(
      batch.toString('latin1', offset, headerEnd),
    );
    if (!header || header[1] !== id) return invalid();
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size) || size > COMMITTED_INPUT_LIMIT) return invalid();
    const start = headerEnd + 1;
    const end = start + size;
    if (end >= batch.length || batch[end] !== 10) return invalid();
    results.push(batch.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== batch.length) return invalid();
  return results;
}

/** Repository-only inspection. Never touches App/provider configuration or credentials. */
export async function inspectPreparation(root: string, expectedCandidate: string) {
  if (!CANDIDATE_SHA.test(expectedCandidate)) throw new Error('Expected a full candidate commit.');
  const before = candidateRevision(root);
  const candidate = before.commit;
  if (candidate !== expectedCandidate)
    throw new Error('Candidate changed; do not inherit prior evidence.');
  const [committedWorkflow, committedLock] = committedInputs(root, candidate, [
    WORKFLOW_PATH,
    'bun.lock',
  ]);
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
  if (!committedWorkflow!.equals(current) || workflow.sourceSnapshot.rawHash !== sourceHash)
    throw new Error('Workflow source changed during inspection.');
  const lock = Buffer.from(await readWorkflowEvidenceText(join(root, 'bun.lock')), 'utf8');
  if (!committedLock!.equals(lock))
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
