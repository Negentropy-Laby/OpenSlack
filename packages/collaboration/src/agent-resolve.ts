import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollaborationActor } from './types.js';

interface AgentNameCache {
  agentId: string;
  displayName: string;
}

const cache: AgentNameCache[] = [];
let cacheLoaded = false;

function loadNameCache(root = process.cwd()): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  const dir = join(root, '.openslack', 'agents', 'registry');
  if (!existsSync(dir)) return;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue;
      try {
        const content = readFileSync(join(dir, name), 'utf-8');
        const idMatch = content.match(/^agent_id:\s*['"]?([^'"\n]+)['"]?/m);
        const nameMatch = content.match(/^display_name:\s*['"]?([^'"\n]+)['"]?/m);
        if (idMatch && nameMatch) {
          cache.push({ agentId: idMatch[1].trim(), displayName: nameMatch[1].trim() });
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* dir doesn't exist */ }
}

export function resolveAgentDisplayName(actor: CollaborationActor, root?: string): string {
  if (actor.kind === 'human') return actor.id;
  if (actor.kind === 'system') return 'System';
  if (actor.kind !== 'agent') return actor.id;

  loadNameCache(root);
  const entry = cache.find((c) => c.agentId === actor.id);
  return entry?.displayName ?? actor.id;
}

export function clearNameCache(): void {
  cache.length = 0;
  cacheLoaded = false;
}
