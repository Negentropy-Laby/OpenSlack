import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';

export interface Decision {
  schema: 'openslack.decision.v1';
  id: string;
  topic: string;
  decision: string;
  rationale: string;
  alternatives?: string[];
  consequences?: string[];
  decidedBy: string;
  createdAt: string;
  status: 'active' | 'superseded';
  supersedes?: string;
  supersededBy?: string;
  supersededAt?: string;
  tags?: string[];
}

function getDecisionDir(): string {
  const dir = join(process.cwd(), '.openslack', 'collaboration', 'decisions');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function generateDecisionId(): string {
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `DEC-${ts}-${rand}`;
}

export function recordDecision(params: {
  topic: string;
  decision: string;
  rationale: string;
  alternatives?: string[];
  consequences?: string[];
  decidedBy: string;
  tags?: string[];
}): Decision {
  const dec: Decision = {
    schema: 'openslack.decision.v1',
    id: generateDecisionId(),
    topic: params.topic,
    decision: params.decision,
    rationale: params.rationale,
    alternatives: params.alternatives || [],
    consequences: params.consequences || [],
    decidedBy: params.decidedBy,
    createdAt: new Date().toISOString(),
    status: 'active',
    tags: params.tags || [],
  };

  const dir = getDecisionDir();
  const path = join(dir, `${dec.id}.yaml`);
  writeFileSync(path, stringifyYaml(dec), 'utf-8');

  return dec;
}

export function listDecisions(): Decision[] {
  const dir = getDecisionDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const decisions: Decision[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const parsed = parseYaml(raw) as Decision;
      if (parsed.schema === 'openslack.decision.v1' && parsed.id) {
        decisions.push(parsed);
      }
    } catch {
      // Skip malformed files
    }
  }

  return decisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getDecision(id: string): Decision | undefined {
  const dir = getDecisionDir();
  const path = join(dir, `${id}.yaml`);

  if (!existsSync(path)) return undefined;

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = parseYaml(raw) as Decision;
    if (parsed.schema === 'openslack.decision.v1' && parsed.id === id) {
      return parsed;
    }
  } catch {
    // Return undefined for malformed files
  }

  return undefined;
}

export function supersedeDecision(id: string, supersededById: string): Decision | undefined {
  const decision = getDecision(id);
  if (!decision) return undefined;
  if (decision.status !== 'active') return undefined;

  decision.status = 'superseded';
  decision.supersededBy = supersededById;
  decision.supersededAt = new Date().toISOString();

  const dir = getDecisionDir();
  const path = join(dir, `${id}.yaml`);
  writeFileSync(path, stringifyYaml(decision), 'utf-8');

  return decision;
}

export function renderDecisionList(decisions: Decision[]): string {
  if (decisions.length === 0) {
    return 'No decisions found.';
  }

  const lines: string[] = [];
  lines.push('Decisions');
  lines.push('═════════');
  lines.push('');

  for (const d of decisions) {
    const statusIcon = d.status === 'active' ? '●' : '○';
    lines.push(`${statusIcon} ${d.id}  ${d.topic.slice(0, 50)}${d.topic.length > 50 ? '...' : ''}`);
    lines.push(`   Decision: ${d.decision.slice(0, 60)}${d.decision.length > 60 ? '...' : ''}`);
  }

  return lines.join('\n');
}

export function renderDecision(decision: Decision): string {
  const lines: string[] = [];

  lines.push(`Decision: ${decision.id}`);
  lines.push('─'.repeat(50));
  lines.push(`Status:    ${decision.status}`);
  lines.push(`Topic:     ${decision.topic}`);
  lines.push(`Decision:  ${decision.decision}`);
  lines.push(`By:        ${decision.decidedBy}`);
  lines.push(`Created:   ${decision.createdAt}`);

  if (decision.supersededBy) {
    lines.push(`Superseded by: ${decision.supersededBy} at ${decision.supersededAt}`);
  }

  if (decision.tags && decision.tags.length > 0) {
    lines.push(`Tags:      ${decision.tags.join(', ')}`);
  }

  lines.push('');
  lines.push('Rationale:');
  lines.push(decision.rationale);

  if (decision.alternatives && decision.alternatives.length > 0) {
    lines.push('');
    lines.push('Alternatives considered:');
    for (const alt of decision.alternatives) {
      lines.push(`  • ${alt}`);
    }
  }

  if (decision.consequences && decision.consequences.length > 0) {
    lines.push('');
    lines.push('Consequences:');
    for (const cons of decision.consequences) {
      lines.push(`  • ${cons}`);
    }
  }

  return lines.join('\n');
}
