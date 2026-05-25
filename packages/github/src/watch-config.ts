import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';

export interface GitHubWatchRoute {
  sink: 'console' | 'slack' | 'webhook';
  channel?: string;
  name?: string;
}

export interface GitHubWatchRepo {
  owner: string;
  repo: string;
  events: string[];
  labels?: { include?: string[]; exclude?: string[] };
  routes?: GitHubWatchRoute[];
  auto_claim?: { enabled: boolean; agent_ids?: string[] };
}

export interface GitHubWatchConfig {
  schema: string;
  repositories: GitHubWatchRepo[];
}

export interface WatchConfigParseResult {
  valid: boolean;
  config?: GitHubWatchConfig;
  errors: string[];
}

const VALID_EVENTS = new Set(['issues.opened', 'issues.reopened', 'issues.labeled']);
const VALID_SINKS = new Set(['console', 'slack', 'webhook']);

export function parseGitHubWatchConfig(yaml: string): WatchConfigParseResult {
  const errors: string[] = [];

  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (e) {
    return { valid: false, errors: [`YAML parse error: ${(e as Error).message}`] };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, errors: ['Parsed YAML is not an object'] };
  }

  const m = parsed as Record<string, unknown>;

  if (m.schema !== 'openslack.github_watch.v1') {
    errors.push(`Invalid schema: "${String(m.schema)}". Expected "openslack.github_watch.v1"`);
  }

  if (!Array.isArray(m.repositories) || m.repositories.length === 0) {
    errors.push('repositories must be a non-empty array');
    return { valid: false, errors };
  }

  const repositories: GitHubWatchRepo[] = [];
  for (let i = 0; i < m.repositories.length; i++) {
    const entry = m.repositories[i];
    if (!entry || typeof entry !== 'object') {
      errors.push(`repositories[${i}]: must be an object`);
      continue;
    }
    const r = entry as Record<string, unknown>;

    if (typeof r.owner !== 'string' || r.owner.length === 0) {
      errors.push(`repositories[${i}].owner is required`);
    }
    if (typeof r.repo !== 'string' || r.repo.length === 0) {
      errors.push(`repositories[${i}].repo is required`);
    }

    const events: string[] = [];
    if (Array.isArray(r.events)) {
      for (const ev of r.events) {
        if (typeof ev === 'string' && VALID_EVENTS.has(ev)) {
          events.push(ev);
        } else {
          errors.push(`repositories[${i}].events: invalid event "${String(ev)}". Must be one of: ${[...VALID_EVENTS].join(', ')}`);
        }
      }
    } else {
      errors.push(`repositories[${i}].events must be a non-empty array`);
    }
    if (events.length === 0 && Array.isArray(r.events)) {
      errors.push(`repositories[${i}].events must contain at least one valid event`);
    }

    let labels: GitHubWatchRepo['labels'];
    if (r.labels && typeof r.labels === 'object') {
      const lb = r.labels as Record<string, unknown>;
      labels = {
        include: Array.isArray(lb.include) ? lb.include.filter((s: unknown) => typeof s === 'string') : undefined,
        exclude: Array.isArray(lb.exclude) ? lb.exclude.filter((s: unknown) => typeof s === 'string') : undefined,
      };
    }

    const routes: GitHubWatchRoute[] = [];
    if (Array.isArray(r.routes)) {
      for (const route of r.routes) {
        if (!route || typeof route !== 'object') continue;
        const rt = route as Record<string, unknown>;
        if (typeof rt.sink !== 'string' || !VALID_SINKS.has(rt.sink)) {
          errors.push(`repositories[${i}].routes: invalid sink "${String(rt.sink)}"`);
          continue;
        }
        routes.push({
          sink: rt.sink as GitHubWatchRoute['sink'],
          channel: typeof rt.channel === 'string' ? rt.channel : undefined,
          name: typeof rt.name === 'string' ? rt.name : undefined,
        });
      }
    }

    let autoClaim: GitHubWatchRepo['auto_claim'];
    if (r.auto_claim && typeof r.auto_claim === 'object') {
      const ac = r.auto_claim as Record<string, unknown>;
      autoClaim = {
        enabled: ac.enabled === true,
        agent_ids: Array.isArray(ac.agent_ids) ? ac.agent_ids.filter((s: unknown) => typeof s === 'string') : undefined,
      };
    }

    repositories.push({
      owner: typeof r.owner === 'string' ? r.owner : '',
      repo: typeof r.repo === 'string' ? r.repo : '',
      events,
      labels,
      routes: routes.length > 0 ? routes : undefined,
      auto_claim: autoClaim,
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    config: {
      schema: m.schema as string,
      repositories,
    },
    errors: [],
  };
}

export function loadGitHubWatchConfig(path: string): WatchConfigParseResult {
  try {
    const yaml = readFileSync(path, 'utf-8');
    return parseGitHubWatchConfig(yaml);
  } catch (e) {
    return { valid: false, errors: [`Failed to read config: ${(e as Error).message}`] };
  }
}
