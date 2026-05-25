import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';

export interface HandoffPrincipal {
  registry_id: string;
  run_id: string;
}

export interface Handoff {
  schema: 'openslack.handoff.v1';
  id: string;
  status: 'open' | 'accepted' | 'closed';
  from: string;
  to: string;
  createdAt: string;
  acceptedAt?: string;
  closedAt?: string;
  issueRef?: string;
  prRef?: string;
  context: string;
  nextSteps: string[];
  notes?: string;
  principal?: HandoffPrincipal;
}

function getHandoffDir(): string {
  const dir = join(process.cwd(), '.openslack', 'collaboration', 'handoffs');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function generateHandoffId(): string {
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `HANDOFF-${ts}-${rand}`;
}

export function createHandoff(params: {
  from: string;
  to: string;
  issueRef?: string;
  prRef?: string;
  context: string;
  nextSteps?: string[];
  notes?: string;
  principal?: HandoffPrincipal;
}): Handoff {
  const handoff: Handoff = {
    schema: 'openslack.handoff.v1',
    id: generateHandoffId(),
    status: 'open',
    from: params.from,
    to: params.to,
    createdAt: new Date().toISOString(),
    issueRef: params.issueRef,
    prRef: params.prRef,
    context: params.context,
    nextSteps: params.nextSteps || [],
    notes: params.notes,
    principal: params.principal,
  };

  const dir = getHandoffDir();
  const path = join(dir, `${handoff.id}.yaml`);
  writeFileSync(path, stringifyYaml(handoff), 'utf-8');

  return handoff;
}

export function listHandoffs(): Handoff[] {
  const dir = getHandoffDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const handoffs: Handoff[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const parsed = parseYaml(raw) as Handoff;
      if (parsed.schema === 'openslack.handoff.v1' && parsed.id) {
        handoffs.push(parsed);
      }
    } catch {
      // Skip malformed files
    }
  }

  return handoffs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getHandoff(id: string): Handoff | undefined {
  const dir = getHandoffDir();
  const path = join(dir, `${id}.yaml`);

  if (!existsSync(path)) return undefined;

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = parseYaml(raw) as Handoff;
    if (parsed.schema === 'openslack.handoff.v1' && parsed.id === id) {
      return parsed;
    }
  } catch {
    // Return undefined for malformed files
  }

  return undefined;
}

export function acceptHandoff(id: string): Handoff | undefined {
  const handoff = getHandoff(id);
  if (!handoff) return undefined;
  if (handoff.status !== 'open') return undefined;

  handoff.status = 'accepted';
  handoff.acceptedAt = new Date().toISOString();

  const dir = getHandoffDir();
  const path = join(dir, `${id}.yaml`);
  writeFileSync(path, stringifyYaml(handoff), 'utf-8');

  return handoff;
}

export function closeHandoff(id: string): Handoff | undefined {
  const handoff = getHandoff(id);
  if (!handoff) return undefined;
  if (handoff.status === 'closed') return undefined;

  handoff.status = 'closed';
  handoff.closedAt = new Date().toISOString();

  const dir = getHandoffDir();
  const path = join(dir, `${id}.yaml`);
  writeFileSync(path, stringifyYaml(handoff), 'utf-8');

  return handoff;
}

export function renderHandoffList(handoffs: Handoff[]): string {
  if (handoffs.length === 0) {
    return 'No handoffs found.';
  }

  const lines: string[] = [];
  lines.push('Handoffs');
  lines.push('════════');
  lines.push('');

  for (const h of handoffs) {
    const statusIcon = h.status === 'open' ? '○' : h.status === 'accepted' ? '◐' : '◉';
    const ref = h.issueRef ? `issue:${h.issueRef}` : h.prRef ? `pr:${h.prRef}` : 'no ref';
    lines.push(`${statusIcon} ${h.id}  ${h.from} → ${h.to}  [${ref}]`);
    lines.push(`   ${h.context.slice(0, 60)}${h.context.length > 60 ? '...' : ''}`);
  }

  return lines.join('\n');
}

export function renderHandoff(handoff: Handoff): string {
  const lines: string[] = [];

  lines.push(`Handoff: ${handoff.id}`);
  lines.push('─'.repeat(50));
  lines.push(`Status:    ${handoff.status}`);
  lines.push(`From:      ${handoff.from}`);
  lines.push(`To:        ${handoff.to}`);
  lines.push(`Created:   ${handoff.createdAt}`);

  if (handoff.acceptedAt) {
    lines.push(`Accepted:  ${handoff.acceptedAt}`);
  }
  if (handoff.closedAt) {
    lines.push(`Closed:    ${handoff.closedAt}`);
  }

  if (handoff.issueRef) {
    lines.push(`Issue:     ${handoff.issueRef}`);
  }
  if (handoff.prRef) {
    lines.push(`PR:        ${handoff.prRef}`);
  }

  lines.push('');
  lines.push('Context:');
  lines.push(handoff.context);

  if (handoff.nextSteps.length > 0) {
    lines.push('');
    lines.push('Next Steps:');
    for (const step of handoff.nextSteps) {
      lines.push(`  • ${step}`);
    }
  }

  if (handoff.principal) {
    lines.push('');
    lines.push(`Principal: ${handoff.principal.registry_id} run=${handoff.principal.run_id}`);
  }

  if (handoff.notes) {
    lines.push('');
    lines.push('Notes:');
    lines.push(handoff.notes);
  }

  return lines.join('\n');
}
