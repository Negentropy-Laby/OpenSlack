import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { EvalSuite, EvalCase } from '../types.js';

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

function loadYamlEvalCase(filePath: string): EvalCase {
  const raw = readFileSync(filePath, 'utf-8');
  const data = parseYaml(raw) as Record<string, unknown>;
  return {
    id: String(data.id || ''),
    title: String(data.title || ''),
    goal: String(data.goal || ''),
    onFailure: String(data.on_failure || 'auto_create_evol') as EvalCase['onFailure'],
    assertions:
      (data.assertions as Array<{ description: string; check: string }>)?.map((a) => ({
        description: String(a.description),
        check: String(a.check),
      })) || [],
    setup: data.setup
      ? { changed_paths: (data.setup as Record<string, unknown>).changed_paths as string[] }
      : undefined,
    scenario: data.scenario
      ? {
          description: String((data.scenario as Record<string, unknown>).description || ''),
          parameters:
            ((data.scenario as Record<string, unknown>).parameters as Record<string, unknown>) ||
            {},
        }
      : undefined,
  };
}

export function loadGoldenSuite(): EvalSuite {
  const root = findRepoRoot();
  const goldenDir = join(root, '.openslack', 'self', 'eval_suites', 'golden');

  if (!existsSync(goldenDir)) {
    return { name: 'golden', cases: [] };
  }

  const files = readdirSync(goldenDir)
    .filter((f) => f.endsWith('.yaml') && f.startsWith('EV-GOLDEN-'))
    .sort();

  const cases = files.map((f) => loadYamlEvalCase(join(goldenDir, f)));

  return { name: 'golden', cases };
}
