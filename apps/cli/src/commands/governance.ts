import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { recordEvent } from '@openslack/collaboration';
import { loadPRReviewPolicy } from '@openslack/pr';
import { renderFindingsPlain } from '@openslack/runtime';
import type { PlainFinding } from '@openslack/runtime';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'openslack.yaml'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

interface CommitAudit {
  sha: string;
  shortSha: string;
  subject: string;
  isMerge: boolean;
  isFromPR: boolean;
  prNumber?: number;
  exceptionFound: boolean;
  hasAiAttribution: boolean;
}

function getRecentCommits(root: string, count: number): CommitAudit[] {
  const output = execSync(`git log --first-parent --format="%H %P %s" -${count} main`, {
    cwd: root,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();

  if (!output) return [];

  return output.split('\n').map((line) => {
    const parts = line.split(' ');
    const sha = parts[0];
    const parentShas: string[] = [];
    let subjectStart = 1;
    for (let i = 1; i < parts.length; i++) {
      if (/^[a-f0-9]{40}$/.test(parts[i])) {
        parentShas.push(parts[i]);
        subjectStart = i + 1;
      } else {
        break;
      }
    }
    const subject = parts.slice(subjectStart).join(' ');
    return {
      sha,
      shortSha: sha.slice(0, 7),
      subject,
      isMerge: parentShas.length >= 2,
      isFromPR: false,
      exceptionFound: false,
      hasAiAttribution: false,
    };
  });
}

export interface MergedPRAuditEvidence {
  number: number;
  baseRefName: string;
  mergeCommitOid?: string;
}

interface MergedPREvidenceResult {
  available: boolean;
  pullRequests: MergedPRAuditEvidence[];
  prShas: Map<string, number>;
}

export function parseMergedPRAuditEvidence(output: string): MergedPRAuditEvidence[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error('Merged PR evidence must be an array.');
  return parsed.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !Number.isSafeInteger((entry as { number?: unknown }).number) ||
      typeof (entry as { baseRefName?: unknown }).baseRefName !== 'string' ||
      (entry as { baseRefName: string }).baseRefName.trim().length === 0
    ) {
      throw new Error('Merged PR evidence is missing number or baseRefName.');
    }
    const mergeCommit = (entry as { mergeCommit?: unknown }).mergeCommit;
    const mergeCommitOid =
      mergeCommit &&
      typeof mergeCommit === 'object' &&
      typeof (mergeCommit as { oid?: unknown }).oid === 'string'
        ? (mergeCommit as { oid: string }).oid
        : undefined;
    return {
      number: (entry as { number: number }).number,
      baseRefName: (entry as { baseRefName: string }).baseRefName,
      mergeCommitOid,
    };
  });
}

export function findNonCanonicalMergedPRs(
  pullRequests: readonly MergedPRAuditEvidence[],
  requiredBaseRef: string,
  effectiveAfterPR: number,
): MergedPRAuditEvidence[] {
  return pullRequests.filter(
    (pr) => pr.number > effectiveAfterPR && pr.baseRefName !== requiredBaseRef,
  );
}

function fetchMergedPREvidence(root: string): MergedPREvidenceResult {
  try {
    const output = execSync(
      'gh pr list --state merged --limit 10000 --json mergeCommit,number,baseRefName',
      {
        cwd: root,
        encoding: 'utf-8',
        stdio: 'pipe',
      },
    ).trim();
    const pullRequests = parseMergedPRAuditEvidence(output || '[]');
    const map = new Map<string, number>();
    for (const pr of pullRequests) {
      if (pr.mergeCommitOid) {
        map.set(pr.mergeCommitOid, pr.number);
      }
    }
    return { available: true, pullRequests, prShas: map };
  } catch {
    return { available: false, pullRequests: [], prShas: new Map() };
  }
}

const ATTRIBUTION_PATTERNS = [
  /co-authored-by:/i,
  /generated with claude/i,
  /generated with chatgpt/i,
  /generated with copilot/i,
  /ai-assisted/i,
  /claude code/i,
  /anthropic/i,
];

// Only the project's own bot is exempted — GitHub squash merge appends this trailer
// when the PR author is openslack-agent-operator[bot]. All other Co-authored-by lines
// (including copilot[bot], dependabot[bot], etc.) remain violations per AGENTS.md.
const BOT_COAUTHORED_RE = /^co-authored-by:\s*openslack-agent-operator\[bot]\s*</im;

const ATTRIBUTION_BASELINE = '9ccdff0';

function checkAttribution(root: string, sha: string): boolean {
  try {
    const body = execSync(`git log -1 --format="%B" ${sha}`, {
      cwd: root,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    const stripped = body.replace(BOT_COAUTHORED_RE, '');
    return ATTRIBUTION_PATTERNS.some((p) => p.test(stripped));
  } catch {
    return false;
  }
}

function getCommitsAfterBaseline(root: string, baseline: string): Set<string> {
  try {
    const output = execSync(`git rev-list ${baseline}..main`, {
      cwd: root,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    if (!output) return new Set();
    return new Set(output.split('\n'));
  } catch {
    return new Set();
  }
}

function findExceptions(root: string): string[] {
  const debtPath = join(root, 'docs', 'developer', 'technical-debt.md');
  if (!existsSync(debtPath)) return [];
  const content = readFileSync(debtPath, 'utf-8');
  const shaMatches = content.match(/[a-f0-9]{7,40}/g) || [];
  return shaMatches;
}

export function governanceCommands(): Command {
  const cmd = new Command('governance').description('OpenSlack governance audit');

  cmd
    .command('audit')
    .description('Audit recent main commits for governance compliance')
    .option('--count <n>', 'Number of commits to audit', '20')
    .option('--format <format>', 'Output format: standard or plain', 'standard')
    .action((options: { count: string; format: string }) => {
      const root = findRepoRoot();
      const count = parseInt(options.count, 10);
      const commits = getRecentCommits(root, count);
      const exceptions = findExceptions(root);
      const policy = loadPRReviewPolicy(root);
      const mergedPREvidence = fetchMergedPREvidence(root);
      const prShas = mergedPREvidence.prShas;
      const hasGhAccess = mergedPREvidence.available;
      const nonCanonicalMergedPRs = findNonCanonicalMergedPRs(
        mergedPREvidence.pullRequests,
        policy.required_base_ref,
        policy.effective_after_pr,
      );
      const baseRefEvidenceUnavailable = !mergedPREvidence.available;

      const commitsAfterBaseline = getCommitsAfterBaseline(root, ATTRIBUTION_BASELINE);

      for (const c of commits) {
        c.exceptionFound = exceptions.some((ex) => c.sha.startsWith(ex) || ex.startsWith(c.sha));
        if (prShas.has(c.sha)) {
          c.isFromPR = true;
          c.prNumber = prShas.get(c.sha);
        }
        if (commitsAfterBaseline.has(c.sha)) {
          c.hasAiAttribution = checkAttribution(root, c.sha);
        }
      }

      const mergeCommits = commits.filter((c) => c.isMerge);
      const squashCommits = commits.filter((c) => !c.isMerge && c.isFromPR);
      const exceptedCommits = commits.filter((c) => !c.isMerge && !c.isFromPR && c.exceptionFound);
      const unverifiedCommits = commits.filter(
        (c) => !c.isMerge && !c.isFromPR && !c.exceptionFound && !hasGhAccess,
      );
      const directCommits = commits.filter(
        (c) => !c.isMerge && !c.isFromPR && !c.exceptionFound && hasGhAccess,
      );
      const attributedCommits = commits.filter((c) => c.hasAiAttribution && !c.exceptionFound);

      const auditFailed =
        directCommits.length > 0 ||
        (!hasGhAccess && unverifiedCommits.length > 0) ||
        attributedCommits.length > 0 ||
        baseRefEvidenceUnavailable ||
        nonCanonicalMergedPRs.length > 0;

      try {
        let summary: string;
        const directCommitFailed =
          directCommits.length > 0 || (!hasGhAccess && unverifiedCommits.length > 0);
        const failures: string[] = [];
        if (directCommitFailed) {
          failures.push(`${directCommits.length} unexplained direct commits`);
        }
        if (attributedCommits.length > 0) {
          failures.push(`${attributedCommits.length} AI attribution violations`);
        }
        if (baseRefEvidenceUnavailable) {
          failures.push('BASE_REF_EVIDENCE_UNAVAILABLE');
        }
        if (nonCanonicalMergedPRs.length > 0) {
          failures.push(
            `${nonCanonicalMergedPRs.length} non-main PR merges after PR #${policy.effective_after_pr}`,
          );
        }
        if (failures.length === 0) {
          summary = `Governance audit passed: ${commits.length} commits checked`;
        } else {
          summary = `Governance audit failed: ${failures.join(', ')}`;
        }

        let nextAction;
        if (directCommitFailed && attributedCommits.length > 0) {
          nextAction = {
            owner: 'human',
            action: 'Fix direct commits and remove AI attribution from commit messages',
          };
        } else if (directCommitFailed) {
          nextAction = {
            owner: 'human',
            action: 'Add exception to docs/developer/technical-debt.md',
          };
        } else if (attributedCommits.length > 0) {
          nextAction = { owner: 'human', action: 'Remove AI attribution from commit messages' };
        } else if (baseRefEvidenceUnavailable) {
          nextAction = {
            owner: 'human',
            action: 'Restore authenticated gh access and rerun the governance audit',
          };
        } else if (nonCanonicalMergedPRs.length > 0) {
          nextAction = {
            owner: 'human',
            action: 'Investigate and record the non-canonical PR merge governance incident',
          };
        }

        recordEvent({
          type: auditFailed ? 'governance.audit.failed' : 'governance.audit.passed',
          actor: { id: 'cli', kind: 'system', provider: 'cli' },
          object: { kind: 'workspace', id: 'governance' },
          source: { kind: 'governance', ref: `last-${count}-commits` },
          summary,
          visibility: 'local',
          redacted: false,
          containsSensitiveData: false,
          risk: auditFailed ? 'high' : 'none',
          nextAction,
        });
      } catch {
        // Best-effort event recording
      }

      if (options.format === 'plain') {
        const findings: PlainFinding[] = [];
        findings.push({
          status: 'informational',
          title: 'Audit scope',
          detail: `Last ${commits.length} commits on main`,
        });
        for (const c of mergeCommits)
          findings.push({ status: 'PASS', title: `Merge: ${c.shortSha}`, detail: c.subject });
        for (const c of squashCommits)
          findings.push({
            status: 'PASS',
            title: `Squash PR #${c.prNumber}: ${c.shortSha}`,
            detail: c.subject,
          });
        for (const c of exceptedCommits)
          findings.push({ status: 'WARN', title: `Excepted: ${c.shortSha}`, detail: c.subject });
        for (const c of unverifiedCommits)
          findings.push({
            status: 'WARN',
            title: `Unverified: ${c.shortSha}`,
            detail: `${c.subject} — install gh CLI`,
          });
        for (const c of directCommits)
          findings.push({
            status: 'FAIL',
            title: `Direct commit: ${c.shortSha}`,
            detail: c.subject,
            nextAction: 'Add exception to technical-debt.md',
          });
        for (const c of attributedCommits)
          findings.push({
            status: 'FAIL',
            title: `Attribution: ${c.shortSha}`,
            detail: c.subject,
            nextAction: 'Remove AI attribution',
          });
        if (baseRefEvidenceUnavailable)
          findings.push({
            status: 'FAIL',
            title: 'BASE_REF_EVIDENCE_UNAVAILABLE',
            detail: 'GitHub merged-PR baseRefName metadata could not be retrieved.',
            nextAction: 'Restore authenticated gh access and rerun governance audit.',
          });
        for (const pr of nonCanonicalMergedPRs)
          findings.push({
            status: 'FAIL',
            title: `Non-canonical PR base: #${pr.number}`,
            detail: `Merged into ${pr.baseRefName}; required base is ${policy.required_base_ref}.`,
          });
        if (!baseRefEvidenceUnavailable && nonCanonicalMergedPRs.length === 0)
          findings.push({
            status: 'PASS',
            title: 'Canonical PR base',
            detail: `All audited PRs after #${policy.effective_after_pr} target ${policy.required_base_ref}.`,
          });
        if (!auditFailed)
          findings.push({
            status: 'PASS',
            title: 'Governance passed',
            detail: `All ${commits.length} commits accounted for`,
          });
        console.log(renderFindingsPlain(findings));
      } else {
        console.log('Governance Audit');
        console.log('════════════════');
        console.log(`Scope: last ${commits.length} commits on main`);
        if (!hasGhAccess)
          console.log(
            'Note: gh CLI not available — PR merge detection limited to true merge commits',
          );
        console.log('');

        if (mergeCommits.length > 0) {
          console.log(`Merge commits: ${mergeCommits.length}`);
          for (const c of mergeCommits) console.log(`  ✓ ${c.shortSha} ${c.subject}`);
          console.log('');
        }
        if (squashCommits.length > 0) {
          console.log(`Squash-merged PR commits: ${squashCommits.length}`);
          for (const c of squashCommits)
            console.log(`  ✓ ${c.shortSha} PR #${c.prNumber} — ${c.subject}`);
          console.log('');
        }
        if (exceptedCommits.length > 0) {
          console.log(`Excepted direct commits: ${exceptedCommits.length}`);
          for (const c of exceptedCommits) {
            console.log(`  ⚠ ${c.shortSha} ${c.subject}`);
            console.log('    Exception found in technical-debt.md');
          }
          console.log('');
        }
        if (unverifiedCommits.length > 0) {
          console.log(`Unverified commits (no gh access): ${unverifiedCommits.length}`);
          for (const c of unverifiedCommits) {
            console.log(`  ? ${c.shortSha} ${c.subject}`);
            console.log('    Cannot verify without gh CLI access');
          }
          console.log('');
        }
        if (directCommits.length > 0) {
          console.log(`UNEXPLAINED direct commits: ${directCommits.length}`);
          for (const c of directCommits) {
            console.log(`  ✗ ${c.shortSha} ${c.subject}`);
            console.log('    No PR merge record and no technical-debt exception');
          }
          console.log('');
          console.log('Action required: add exception to docs/developer/technical-debt.md');
        }
        if (!hasGhAccess && unverifiedCommits.length > 0) {
          console.log(
            'Some commits could not be verified. Install gh CLI and authenticate for full audit.',
          );
        }
        if (attributedCommits.length > 0) {
          console.log(`AI attribution violations: ${attributedCommits.length}`);
          for (const c of attributedCommits) {
            console.log(`  ✗ ${c.shortSha} ${c.subject}`);
            console.log('    Contains prohibited attribution pattern');
          }
          console.log('');
          console.log(
            'Action required: remove AI attribution from commit messages. See AGENTS.md hard prohibitions.',
          );
        }
        if (baseRefEvidenceUnavailable) {
          console.log('BASE_REF_EVIDENCE_UNAVAILABLE');
          console.log('GitHub merged-PR baseRefName metadata could not be retrieved.');
          console.log('');
        } else if (nonCanonicalMergedPRs.length > 0) {
          console.log(`Non-canonical merged PRs: ${nonCanonicalMergedPRs.length}`);
          for (const pr of nonCanonicalMergedPRs) {
            console.log(
              `  PR #${pr.number} merged into ${pr.baseRefName}; required base is ${policy.required_base_ref}`,
            );
          }
          console.log('');
        } else {
          console.log(`Canonical PR base violations after #${policy.effective_after_pr}: 0`);
        }
        if (!auditFailed) {
          console.log('Unexplained direct commits: 0');
          console.log('AI attribution violations: 0');
          console.log('');
          console.log('All commits accounted for. No governance drift detected.');
        }
      }

      if (auditFailed) process.exit(1);
    });

  return cmd;
}
