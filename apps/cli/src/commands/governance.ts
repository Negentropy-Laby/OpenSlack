import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

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
}

function getRecentCommits(root: string, count: number): CommitAudit[] {
  const output = execSync(
    `git log --first-parent --format="%H %P %s" -${count} main`,
    { cwd: root, encoding: 'utf-8', stdio: 'pipe' },
  ).trim();

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
    };
  });
}

function fetchMergedPRShas(root: string): Map<string, number> {
  try {
    const output = execSync(
      'gh pr list --state merged --limit 100 --json mergeCommit,number',
      { cwd: root, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    if (!output) return new Map();
    const prs = JSON.parse(output) as Array<{ mergeCommit?: { oid?: string }; number: number }>;
    const map = new Map<string, number>();
    for (const pr of prs) {
      if (pr.mergeCommit?.oid) {
        map.set(pr.mergeCommit.oid, pr.number);
      }
    }
    return map;
  } catch {
    return new Map();
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
    .action((options: { count: string }) => {
      const root = findRepoRoot();
      const count = parseInt(options.count, 10);
      const commits = getRecentCommits(root, count);
      const exceptions = findExceptions(root);
      const prShas = fetchMergedPRShas(root);
      const hasGhAccess = prShas.size > 0;

      for (const c of commits) {
        c.exceptionFound = exceptions.some((ex) => c.sha.startsWith(ex) || ex.startsWith(c.sha));
        if (prShas.has(c.sha)) {
          c.isFromPR = true;
          c.prNumber = prShas.get(c.sha);
        }
      }

      const mergeCommits = commits.filter((c) => c.isMerge);
      const squashCommits = commits.filter((c) => !c.isMerge && c.isFromPR);
      const exceptedCommits = commits.filter((c) => !c.isMerge && !c.isFromPR && c.exceptionFound);
      const unverifiedCommits = commits.filter((c) => !c.isMerge && !c.isFromPR && !c.exceptionFound && !hasGhAccess);
      const directCommits = commits.filter((c) => !c.isMerge && !c.isFromPR && !c.exceptionFound && hasGhAccess);

      console.log('Governance Audit');
      console.log('════════════════');
      console.log(`Scope: last ${commits.length} commits on main`);
      if (!hasGhAccess) {
        console.log('Note: gh CLI not available — PR merge detection limited to true merge commits');
      }
      console.log('');

      if (mergeCommits.length > 0) {
        console.log(`Merge commits: ${mergeCommits.length}`);
        for (const c of mergeCommits) {
          console.log(`  ✓ ${c.shortSha} ${c.subject}`);
        }
        console.log('');
      }

      if (squashCommits.length > 0) {
        console.log(`Squash-merged PR commits: ${squashCommits.length}`);
        for (const c of squashCommits) {
          console.log(`  ✓ ${c.shortSha} PR #${c.prNumber} — ${c.subject}`);
        }
        console.log('');
      }

      if (exceptedCommits.length > 0) {
        console.log(`Excepted direct commits: ${exceptedCommits.length}`);
        for (const c of exceptedCommits) {
          console.log(`  ⚠ ${c.shortSha} ${c.subject}`);
          console.log(`    Exception found in technical-debt.md`);
        }
        console.log('');
      }

      if (unverifiedCommits.length > 0) {
        console.log(`Unverified commits (no gh access): ${unverifiedCommits.length}`);
        for (const c of unverifiedCommits) {
          console.log(`  ? ${c.shortSha} ${c.subject}`);
          console.log(`    Cannot verify without gh CLI access`);
        }
        console.log('');
      }

      if (directCommits.length > 0) {
        console.log(`UNEXPLAINED direct commits: ${directCommits.length}`);
        for (const c of directCommits) {
          console.log(`  ✗ ${c.shortSha} ${c.subject}`);
          console.log(`    No PR merge record and no technical-debt exception`);
        }
        console.log('');
        console.log('Action required: add exception to docs/developer/technical-debt.md');
        process.exit(1);
      }

      if (!hasGhAccess && unverifiedCommits.length > 0) {
        console.log('Some commits could not be verified. Install gh CLI and authenticate for full audit.');
        process.exit(1);
      }

      console.log('Unexplained direct commits: 0');
      console.log('');
      console.log('All commits accounted for. No governance drift detected.');
    });

  return cmd;
}
