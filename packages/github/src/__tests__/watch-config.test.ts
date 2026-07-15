import { describe, it, expect } from 'vitest';
import { parseGitHubWatchConfig } from '../watch-config.js';
import { GITHUB_WATCH_EVENT_KEYS } from '../repository-event.js';

describe('watch-config', () => {
  it('parses a valid full config', () => {
    const yaml = `
schema: openslack.github_watch.v1
repositories:
  - owner: Negentropy-Laby
    repo: OpenSlack
    events:
      - issues.opened
      - issues.reopened
      - issues.labeled
    labels:
      include:
        - openslack:task
      exclude:
        - blocked
    routes:
      - sink: slack
        channel: "#openslack-tasks"
      - sink: webhook
        name: local-dev
    auto_claim:
      enabled: false
      agent_ids:
        - openai_developer_ci-bot
`;
    const result = parseGitHubWatchConfig(yaml);
    expect(result.valid).toBe(true);
    expect(result.config?.schema).toBe('openslack.github_watch.v1');
    expect(result.config?.repositories).toHaveLength(1);
    expect(result.config?.repositories[0].owner).toBe('Negentropy-Laby');
    expect(result.config?.repositories[0].events).toEqual([
      'issues.opened',
      'issues.reopened',
      'issues.labeled',
    ]);
    expect(result.config?.repositories[0].labels?.include).toEqual(['openslack:task']);
    expect(result.config?.repositories[0].labels?.exclude).toEqual(['blocked']);
    expect(result.config?.repositories[0].routes).toHaveLength(2);
    expect(result.config?.repositories[0].auto_claim?.enabled).toBe(false);
  });

  it('rejects invalid schema', () => {
    const yaml = `
schema: wrong.schema.v1
repositories:
  - owner: foo
    repo: bar
    events: [issues.opened]
`;
    const result = parseGitHubWatchConfig(yaml);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Invalid schema');
  });

  it('rejects empty repositories', () => {
    const yaml = `
schema: openslack.github_watch.v1
repositories: []
`;
    const result = parseGitHubWatchConfig(yaml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('non-empty'))).toBe(true);
  });

  it('rejects invalid event types', () => {
    const yaml = `
schema: openslack.github_watch.v1
repositories:
  - owner: foo
    repo: bar
    events: [pull_request.edited]
`;
    const result = parseGitHubWatchConfig(yaml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('invalid event'))).toBe(true);
  });

  it('accepts every canonical repository event including push', () => {
    const yaml = `
schema: openslack.github_watch.v1
repositories:
  - owner: foo
    repo: bar
    events: [${GITHUB_WATCH_EVENT_KEYS.join(', ')}]
`;
    const result = parseGitHubWatchConfig(yaml);
    expect(result.valid).toBe(true);
    expect(result.config?.repositories[0].events).toEqual(GITHUB_WATCH_EVENT_KEYS);
  });

  it('rejects duplicate canonical routes without requiring route ids', () => {
    const yaml = `
schema: openslack.github_watch.v1
repositories:
  - owner: Acme
    repo: Project
    events: [pull_request.opened]
    routes:
      - sink: slack
        name: Primary
        channel: "#Release"
      - sink: slack
        name: " primary "
        channel: " #release "
`;
    const result = parseGitHubWatchConfig(yaml);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'repositories[0].routes: duplicate canonical route for sink "slack"',
    );
  });

  it('rejects duplicate repositories case-insensitively', () => {
    const yaml = `
schema: openslack.github_watch.v1
repositories:
  - owner: Acme
    repo: Project
    events: [issues.opened]
  - owner: acme
    repo: project
    events: [push]
`;
    const result = parseGitHubWatchConfig(yaml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('duplicate repository'))).toBe(true);
  });

  it('accepts minimal config without optional fields', () => {
    const yaml = `
schema: openslack.github_watch.v1
repositories:
  - owner: my-org
    repo: my-repo
    events: [issues.opened]
`;
    const result = parseGitHubWatchConfig(yaml);
    expect(result.valid).toBe(true);
    expect(result.config?.repositories[0].labels).toBeUndefined();
    expect(result.config?.repositories[0].routes).toBeUndefined();
  });

  it('rejects YAML parse errors', () => {
    const result = parseGitHubWatchConfig('  : invalid: [yaml: {{{');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('YAML parse error');
  });
});
