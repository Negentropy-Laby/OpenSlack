import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd());
const ignoredTemplates = [
  'templates/new-agent/claim_policy.yaml',
  'templates/new-agent/github_task_contract.yaml',
] as const;

interface ClaimPolicy {
  lease: {
    ttl_minutes: number;
    heartbeat_interval_minutes: number;
  };
  concurrency: {
    max_parallel_tasks: number;
  };
}

interface GithubTaskContract {
  github: {
    project_number: number;
  };
  claim: {
    lease_ttl_minutes: number;
    heartbeat_interval_minutes: number;
    max_parallel_tasks: number;
  };
}

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function renderTemplate(template: string): string {
  const replacements: Record<string, string> = {
    AGENT_ID: 'fixture-agent',
    GITHUB_OWNER: 'Negentropy-Laby',
    GITHUB_REPO: 'OpenSlack',
    PROJECT_NUMBER: '42',
    MAX_RISK_LEVEL: 'medium',
    LEASE_TTL_MINUTES: '60',
    HEARTBEAT_INTERVAL: '10',
    MAX_PARALLEL_TASKS: '1',
  };

  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, name: string) => {
    const replacement = replacements[name];
    if (replacement === undefined) {
      throw new Error(`Missing fixture replacement for ${placeholder}`);
    }
    return replacement;
  });
}

describe('new-agent template format safety', () => {
  it('ignores exactly the two Mustache YAML templates', () => {
    const ignoredPaths = readRepoFile('.prettierignore')
      .split(/\r?\n/)
      .filter((line) => line.length > 0);

    expect(ignoredPaths).toEqual(ignoredTemplates);
  });

  it('preserves seven unquoted numeric placeholders', () => {
    const templates = ignoredTemplates.map(readRepoFile);
    const numericPlaceholders = templates.flatMap((template) =>
      [
        ...template.matchAll(
          /:\s*(\{\{(?:PROJECT_NUMBER|LEASE_TTL_MINUTES|HEARTBEAT_INTERVAL|MAX_PARALLEL_TASKS)\}\})\s*$/gm,
        ),
      ].map(([, placeholder]) => placeholder),
    );

    expect(numericPlaceholders).toHaveLength(7);
    expect(numericPlaceholders).toEqual([
      '{{LEASE_TTL_MINUTES}}',
      '{{HEARTBEAT_INTERVAL}}',
      '{{MAX_PARALLEL_TASKS}}',
      '{{PROJECT_NUMBER}}',
      '{{LEASE_TTL_MINUTES}}',
      '{{HEARTBEAT_INTERVAL}}',
      '{{MAX_PARALLEL_TASKS}}',
    ]);
  });

  it('renders the unquoted placeholders as YAML numbers', () => {
    const claimPolicy = parseYaml(renderTemplate(readRepoFile(ignoredTemplates[0]))) as ClaimPolicy;
    const githubTaskContract = parseYaml(
      renderTemplate(readRepoFile(ignoredTemplates[1])),
    ) as GithubTaskContract;

    expect(claimPolicy.lease).toEqual({
      ttl_minutes: 60,
      heartbeat_interval_minutes: 10,
    });
    expect(claimPolicy.concurrency).toEqual({ max_parallel_tasks: 1 });
    expect(githubTaskContract.github.project_number).toBe(42);
    expect(githubTaskContract.claim).toEqual({
      lease_ttl_minutes: 60,
      heartbeat_interval_minutes: 10,
      max_parallel_tasks: 1,
    });
  });
});
