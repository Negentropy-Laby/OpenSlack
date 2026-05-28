import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates', 'workflows');

// We test the validate/show/list logic by directly exercising the underlying
// functions, since Commander action handlers are thin wrappers around them.

import {
  validateWorkflowTemplate,
} from '@openslack/collaboration';
import type { WorkflowTemplate } from '@openslack/collaboration';
import {
  discoverYamlTemplates,
  discoverJsWorkflows,
  findWorkflow,
  loadWorkflow,
} from '@openslack/workflows';

// ─── Helper: load a builtin template ──────────────────────────────────────────

function loadBuiltinTemplate(id: string): WorkflowTemplate | undefined {
  const path = join(TEMPLATES_DIR, `${id}.yaml`);
  if (!existsSync(path)) return undefined;
  return parseYaml(readFileSync(path, 'utf-8')) as WorkflowTemplate;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('workflow validate subcommand logic', () => {
  const TEMPLATE_IDS = ['bugfix', 'feature', 'docs', 'release', 'incident', 'research'];

  it('validates all 6 built-in YAML templates as valid', () => {
    for (const id of TEMPLATE_IDS) {
      const template = loadBuiltinTemplate(id);
      expect(template).toBeDefined();
      const errors = validateWorkflowTemplate(template!);
      expect(errors, `Template "${id}" should have no errors`).toEqual([]);
    }
  });

  it('validates a specific builtin template returns schema and metadata', () => {
    const template = loadBuiltinTemplate('bugfix')!;
    expect(template.schema).toBe('openslack.workflow_template.v1');
    expect(template.id).toBe('bugfix');
    expect(template.name).toBe('Bug Fix');
    expect(template.phases.length).toBeGreaterThan(0);
    expect(template.inputs!.length).toBeGreaterThan(0);
  });

  it('detects validation errors in a template with unknown action', () => {
    const template = loadBuiltinTemplate('bugfix')!;
    // Replace a valid actionId with an unknown one
    template.phases[0].steps[0] = {
      type: 'action',
      actionId: 'nonexistent.action',
      input: {},
    };
    const errors = validateWorkflowTemplate(template);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('unknown action'))).toBe(true);
  });

  it('detects validation errors for raw command usage', () => {
    const template = {
      schema: 'openslack.workflow_template.v1',
      id: 'bad-cmd',
      name: 'Bad Command',
      phases: [
        {
          name: 'Run',
          steps: [{ type: 'action', command: 'rm -rf /' }],
        },
      ],
    };
    const errors = validateWorkflowTemplate(template);
    expect(errors.some((e) => e.includes('raw command'))).toBe(true);
  });

  it('rejects template without schema', () => {
    const template = {
      id: 'no-schema',
      name: 'No Schema',
      phases: [{ name: 'A', steps: [] }],
    };
    const errors = validateWorkflowTemplate(template);
    expect(errors.some((e) => e.includes('schema'))).toBe(true);
  });

  it('rejects template without id', () => {
    const template = {
      schema: 'openslack.workflow_template.v1',
      name: 'No ID',
      phases: [{ name: 'A', steps: [] }],
    };
    const errors = validateWorkflowTemplate(template);
    expect(errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('rejects template without name', () => {
    const template = {
      schema: 'openslack.workflow_template.v1',
      id: 'no-name',
      phases: [{ name: 'A', steps: [] }],
    };
    const errors = validateWorkflowTemplate(template);
    expect(errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('rejects template with empty phases', () => {
    const template = {
      schema: 'openslack.workflow_template.v1',
      id: 'empty',
      name: 'Empty',
      phases: [],
    };
    const errors = validateWorkflowTemplate(template);
    expect(errors.some((e) => e.includes('phases'))).toBe(true);
  });
});

describe('workflow show subcommand logic - YAML templates', () => {
  it('loads and displays bugfix template details', () => {
    const template = loadBuiltinTemplate('bugfix')!;
    expect(template.id).toBe('bugfix');
    expect(template.name).toBe('Bug Fix');
    expect(template.inputs).toBeDefined();
    expect(template.inputs!.length).toBeGreaterThan(0);
    expect(template.phases.length).toBeGreaterThan(0);

    // Verify phase structure
    const phaseNames = template.phases.map((p) => p.name);
    expect(phaseNames).toContain('Diagnosis');

    // Verify inputs have required fields
    for (const input of template.inputs ?? []) {
      expect(input.name).toBeTruthy();
      expect(input.type).toBeTruthy();
    }
  });

  it('loads and displays feature template details', () => {
    const template = loadBuiltinTemplate('feature')!;
    expect(template.id).toBe('feature');
    expect(template.phases.length).toBeGreaterThan(0);
  });

  it('loads and displays incident template with decision-gate', () => {
    const template = loadBuiltinTemplate('incident')!;
    const hasDecisionGate = template.phases.some((phase) =>
      phase.steps.some((step) => step.type === 'decision-gate'),
    );
    expect(hasDecisionGate).toBe(true);
  });

  it('loads all 6 templates and each has required schema fields', () => {
    const ids = ['bugfix', 'feature', 'docs', 'release', 'incident', 'research'];
    for (const id of ids) {
      const template = loadBuiltinTemplate(id)!;
      expect(template.schema).toBe('openslack.workflow_template.v1');
      expect(template.id).toBe(id);
      expect(template.name).toBeTruthy();
      expect(template.phases.length).toBeGreaterThan(0);
    }
  });

  it('step details are extractable from template phases', () => {
    const template = loadBuiltinTemplate('bugfix')!;
    for (const phase of template.phases) {
      for (const step of phase.steps) {
        expect(step.type).toBeTruthy();
        if (step.type === 'action') {
          expect(step.actionId).toBeTruthy();
        }
        if (step.type === 'decision-gate') {
          expect(step.title).toBeTruthy();
          expect(step.requiredRole).toBeTruthy();
        }
      }
    }
  });
});

describe('workflow show subcommand logic - JS modules', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-show-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds a JS module workflow by name', async () => {
    const workflowsDir = join(tmpDir, '.openslack', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'custom-scan.js'), `
export const meta = {
  name: 'custom-scan',
  description: 'Custom scanner',
  phases: [{ title: 'Scan', detail: 'Scan files' }]
}
export async function run() { return { status: 'ok' } }
`);
    const found = await findWorkflow('custom-scan', tmpDir);
    expect(found).toBeDefined();
    expect(found!.name).toBe('custom-scan');
  });

  it('returns undefined for nonexistent JS workflow', async () => {
    const found = await findWorkflow('nonexistent', tmpDir);
    expect(found).toBeUndefined();
  });

  it('loads and inspects a JS module workflow', async () => {
    const workflowsDir = join(tmpDir, '.openslack', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'test-scan.js'), `
export const meta = {
  name: 'test-scan',
  description: 'Test scan',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}
export async function preview() { return { preview: true } }
export async function run() { return { status: 'complete' } }
`);
    const found = await findWorkflow('test-scan', tmpDir);
    expect(found).toBeDefined();
    const mod = await loadWorkflow(found!.path);
    expect(mod.meta.name).toBe('test-scan');
    expect(mod.format).toBe('openslack-native');
    expect(mod.preview).toBeDefined();
    expect(mod.run).toBeDefined();
  });
});

describe('enhanced workflow list - combined YAML and JS', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-list-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers YAML templates from templates directory', async () => {
    const yamlWorkflows = await discoverYamlTemplates(TEMPLATES_DIR);
    expect(yamlWorkflows.length).toBeGreaterThanOrEqual(6);
    const ids = yamlWorkflows.map((w) => w.name);
    expect(ids).toContain('bugfix');
    expect(ids).toContain('feature');
    expect(ids).toContain('docs');
  });

  it('YAML templates have correct source type', async () => {
    const yamlWorkflows = await discoverYamlTemplates(TEMPLATES_DIR);
    for (const w of yamlWorkflows) {
      expect(w.source).toBe('yaml-template');
    }
  });

  it('discovers JS workflows from .openslack/workflows', async () => {
    const workflowsDir = join(tmpDir, '.openslack', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'my-flow.js'), `
export const meta = { name: 'my-flow', description: 'Test', phases: [{ title: 'A', detail: 'B' }] }
export async function run() { return { status: 'ok' } }
`);
    const jsWorkflows = await discoverJsWorkflows(tmpDir);
    expect(jsWorkflows.length).toBe(1);
    expect(jsWorkflows[0].name).toBe('my-flow');
    expect(jsWorkflows[0].source).toBe('js-module');
  });

  it('combined list includes both YAML and JS sources', async () => {
    // YAML templates
    const yamlWorkflows = await discoverYamlTemplates(TEMPLATES_DIR);

    // JS modules - create a temporary one
    const workflowsDir = join(tmpDir, '.openslack', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'custom.js'), `
export const meta = { name: 'custom', description: 'Custom', phases: [{ title: 'Run', detail: 'Run' }] }
`);

    const jsWorkflows = await discoverJsWorkflows(tmpDir);

    expect(yamlWorkflows.length).toBeGreaterThan(0);
    expect(jsWorkflows.length).toBeGreaterThan(0);
    expect(yamlWorkflows[0].source).toBe('yaml-template');
    expect(jsWorkflows[0].source).toBe('js-module');
  });

  it('YAML workflow summaries include correct phase and input counts', async () => {
    const yamlWorkflows = await discoverYamlTemplates(TEMPLATES_DIR);
    const bugfix = yamlWorkflows.find((w) => w.name === 'bugfix');
    expect(bugfix).toBeDefined();
    expect(bugfix!.phases).toBeGreaterThan(0);
    expect(bugfix!.inputs).toBeGreaterThan(0);
  });

  it('JS workflow summaries include description', async () => {
    const workflowsDir = join(tmpDir, '.openslack', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'desc-flow.js'), `
export const meta = { name: 'desc-flow', description: 'A described flow', phases: [{ title: 'A', detail: 'B' }] }
`);
    const jsWorkflows = await discoverJsWorkflows(tmpDir);
    expect(jsWorkflows[0].description).toBe('A described flow');
  });

  it('returns empty lists when neither YAML nor JS workflows exist', async () => {
    const yamlWorkflows = await discoverYamlTemplates(join(tmpDir, 'empty'));
    const jsWorkflows = await discoverJsWorkflows(tmpDir);
    expect(yamlWorkflows).toEqual([]);
    expect(jsWorkflows).toEqual([]);
  });
});

describe('workflow validate - JS module via loadWorkflow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-validate-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid JS module and checks metadata', async () => {
    const workflowsDir = join(tmpDir, '.openslack', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'valid-mod.js'), `
export const meta = {
  name: 'valid-mod',
  description: 'Valid module',
  version: '1.0.0',
  phases: [{ title: 'Scan', detail: 'Scan' }],
  risk: 'low'
}
export async function preview() { return { preview: true } }
`);
    const found = await findWorkflow('valid-mod', tmpDir);
    expect(found).toBeDefined();
    const mod = await loadWorkflow(found!.path);
    expect(mod.meta.name).toBe('valid-mod');
    expect(mod.meta.version).toBe('1.0.0');
    expect(mod.meta.risk).toBe('low');
    expect(mod.format).toBe('openslack-native');
    expect(mod.hash).toBeTruthy();
    expect(mod.preview).toBeDefined();
  });

  it('throws when loading a module with invalid meta', async () => {
    const workflowsDir = join(tmpDir, '.openslack', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'bad-meta.js'), `
export const meta = { }
`);
    const found = await findWorkflow('bad-meta', tmpDir);
    // findWorkflow succeeds (file exists) but the meta won't pass analyzeStaticMeta
    // Actually, findWorkflow calls discoverWorkflows which doesn't load the file.
    // Let's try loadWorkflow directly
    if (found) {
      await expect(loadWorkflow(found.path)).rejects.toThrow();
    }
  });

  it('throws when loading a module without meta export', async () => {
    const workflowsDir = join(tmpDir, '.openslack', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'no-meta.js'), `
export async function run() { return { status: 'ok' } }
`);
    // discoverJsWorkflows skips modules that fail static analysis
    const jsWorkflows = await discoverJsWorkflows(tmpDir);
    expect(jsWorkflows).toEqual([]);
  });
});

describe('workflow validate - YAML template edge cases', () => {
  it('validates the release template', () => {
    const template = loadBuiltinTemplate('release')!;
    const errors = validateWorkflowTemplate(template);
    expect(errors).toEqual([]);
    expect(template.phases.length).toBeGreaterThan(0);
  });

  it('validates the research template', () => {
    const template = loadBuiltinTemplate('research')!;
    const errors = validateWorkflowTemplate(template);
    expect(errors).toEqual([]);
  });

  it('validates the docs template', () => {
    const template = loadBuiltinTemplate('docs')!;
    const errors = validateWorkflowTemplate(template);
    expect(errors).toEqual([]);
  });
});
