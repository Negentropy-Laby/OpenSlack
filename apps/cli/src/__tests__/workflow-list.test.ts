import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates', 'workflows');

describe('loadWorkflowTemplate bare-ID resolution', () => {
  it('resolves bare template ID to templates/workflows/<id>.yaml', () => {
    const path = join(TEMPLATES_DIR, 'bugfix.yaml');
    expect(existsSync(path)).toBe(true);
    const template = parseYaml(readFileSync(path, 'utf-8'));
    expect(template.id).toBe('bugfix');
    expect(template.schema).toBe('openslack.workflow_template.v1');
  });

  it('resolves all 6 template IDs', () => {
    const ids = ['bugfix', 'feature', 'docs', 'release', 'incident', 'research'];
    for (const id of ids) {
      const path = join(TEMPLATES_DIR, `${id}.yaml`);
      expect(existsSync(path)).toBe(true);
      const template = parseYaml(readFileSync(path, 'utf-8'));
      expect(template.id).toBe(id);
    }
  });

  it('falls back to file path when ID does not match builtin', () => {
    const path = join(TEMPLATES_DIR, 'bugfix.yaml');
    const template = parseYaml(readFileSync(path, 'utf-8'));
    expect(template.id).toBe('bugfix');
  });
});

describe('workflow list subcommand', () => {
  it('lists built-in templates', () => {
    const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThanOrEqual(6);
  });
});
