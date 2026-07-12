import { execFileSync } from 'node:child_process';
import { createWorkflowEvidence, NoWorkflowArtifactChangeError } from './workflow-gate.js';
import type { WorkflowEvidence, WorkflowTreeEntry } from './types.js';

export function parseGitLsTree(output: Buffer | string): WorkflowTreeEntry[] {
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : output;
  return text.split('\0').flatMap((record) => {
    if (!record) return [];
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('Malformed git ls-tree record.');
    const [mode, type, sha] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (!mode || !type || !sha || !path) throw new Error('Malformed git ls-tree record.');
    return [{ mode, type, sha, path }];
  });
}

function readTree(revision: string, rootDir: string): WorkflowTreeEntry[] {
  const output = execFileSync('git', ['ls-tree', '-r', '-z', revision], {
    cwd: rootDir,
    encoding: 'buffer',
    windowsHide: true,
  });
  return parseGitLsTree(output);
}

function resolveCommit(revision: string, rootDir: string): string {
  return execFileSync('git', ['rev-parse', `${revision}^{commit}`], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

export function computeLocalWorkflowEvidence(
  baseSha: string,
  headSha: string,
  rootDir = process.cwd(),
): WorkflowEvidence | undefined {
  const resolvedBaseSha = resolveCommit(baseSha, rootDir);
  const resolvedHeadSha = resolveCommit(headSha, rootDir);
  const baseTree = readTree(resolvedBaseSha, rootDir);
  const headTree = readTree(resolvedHeadSha, rootDir);
  try {
    return createWorkflowEvidence({
      baseSha: resolvedBaseSha,
      headSha: resolvedHeadSha,
      baseTree,
      headTree,
    });
  } catch (error) {
    if (error instanceof NoWorkflowArtifactChangeError) {
      return undefined;
    }
    throw error;
  }
}
