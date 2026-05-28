import { describe, it, expect } from 'vitest';
import { validateWorkflowTemplate } from '../workflow.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getRegisteredAction } from '@openslack/operator';

const WORKFLOWS_DIR = join(process.cwd(), 'templates/workflows');

function loadTemplate(filename: string) {
  return parseYaml(readFileSync(join(WORKFLOWS_DIR, filename), 'utf-8'));
}

describe('built-in workflow templates', () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yaml'));

  it('has at least 8 templates', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  const templates = files.map((f) => {
    const raw = parseYaml(readFileSync(join(WORKFLOWS_DIR, f), 'utf-8'));
    return { file: f, ...raw };
  });

  for (const template of templates) {
    describe(`${template.file} (id=${template.id})`, () => {
      it('passes validateWorkflowTemplate', () => {
        const errors = validateWorkflowTemplate(template);
        expect(errors).toEqual([]);
      });

      it('references only registered actions', () => {
        for (const phase of template.phases ?? []) {
          for (const step of phase.steps ?? []) {
            if (step.type === 'action') {
              expect(getRegisteredAction(step.actionId)).toBeDefined();
            }
          }
        }
      });

      it('has valid schema, id, and name', () => {
        expect(template.schema).toBe('openslack.workflow_template.v1');
        expect(template.id).toBeTruthy();
        expect(template.name).toBeTruthy();
      });

      it('has a non-empty description', () => {
        expect(typeof template.description).toBe('string');
        expect(template.description.length).toBeGreaterThan(0);
      });

      it('has a valid riskLevel', () => {
        const validLevels = ['none', 'low', 'medium', 'high'];
        expect(validLevels).toContain(template.riskLevel);
      });

      it('has a non-empty tags array', () => {
        expect(Array.isArray(template.tags)).toBe(true);
        expect(template.tags.length).toBeGreaterThan(0);
      });

      it('input references in steps match input definitions', () => {
        const inputNames = new Set((template.inputs ?? []).map((i: { name: string }) => i.name));
        const inputRefs = new Set<string>();
        for (const phase of template.phases ?? []) {
          for (const step of phase.steps ?? []) {
            if (step.type === 'action' && step.input) {
              for (const value of Object.values(step.input as Record<string, string>)) {
                if (typeof value === 'string') {
                  const matches = value.matchAll(/{{\s*inputs\.([a-zA-Z0-9_-]+)\s*}}/g);
                  for (const m of matches) inputRefs.add(m[1]);
                }
              }
            }
            if (step.type === 'handoff') {
              for (const field of ['from', 'to', 'context', 'issueRef'] as const) {
                const val = step[field];
                if (typeof val === 'string') {
                  const matches = val.matchAll(/{{\s*inputs\.([a-zA-Z0-9_-]+)\s*}}/g);
                  for (const m of matches) inputRefs.add(m[1]);
                }
              }
            }
            if (step.type === 'record-decision') {
              for (const field of ['topic', 'decision', 'rationale', 'decidedBy'] as const) {
                const val = step[field];
                if (typeof val === 'string') {
                  const matches = val.matchAll(/{{\s*inputs\.([a-zA-Z0-9_-]+)\s*}}/g);
                  for (const m of matches) inputRefs.add(m[1]);
                }
              }
              if (Array.isArray(step.tags)) {
                for (const tag of step.tags) {
                  if (typeof tag === 'string') {
                    const matches = tag.matchAll(/{{\s*inputs\.([a-zA-Z0-9_-]+)\s*}}/g);
                    for (const m of matches) inputRefs.add(m[1]);
                  }
                }
              }
            }
          }
        }
        for (const ref of inputRefs) {
          expect(inputNames.has(ref)).toBe(true);
        }
      });
    });
  }
});

describe('refactor template', () => {
  const template = loadTemplate('refactor.yaml');

  it('has id refactor', () => {
    expect(template.id).toBe('refactor');
  });

  it('has four phases: Analysis, Planning, Implementation, Review', () => {
    expect(template.phases.map((p: { name: string }) => p.name)).toEqual([
      'Analysis',
      'Planning',
      'Implementation',
      'Review',
    ]);
  });

  it('Planning phase contains a record-decision step', () => {
    const planning = template.phases[1];
    expect(planning.steps.some((s: { type: string }) => s.type === 'record-decision')).toBe(true);
  });

  it('Review phase contains a decision-gate and merge action', () => {
    const review = template.phases[3];
    const types = review.steps.map((s: { type: string }) => s.type);
    expect(types).toContain('decision-gate');
    expect(types).toContain('action');
    const mergeStep = review.steps.find((s: { actionId?: string }) => s.actionId === 'pr.merge');
    expect(mergeStep).toBeDefined();
  });

  it('passes validateWorkflowTemplate', () => {
    expect(validateWorkflowTemplate(template)).toEqual([]);
  });

  it('has medium riskLevel', () => {
    expect(template.riskLevel).toBe('medium');
  });
});

describe('docs-update template', () => {
  const template = loadTemplate('docs-update.yaml');

  it('has id docs-update', () => {
    expect(template.id).toBe('docs-update');
  });

  it('has three phases: Audit, Update, Verify', () => {
    expect(template.phases.map((p: { name: string }) => p.name)).toEqual([
      'Audit',
      'Update',
      'Verify',
    ]);
  });

  it('Audit phase contains a record-decision step', () => {
    const audit = template.phases[0];
    expect(audit.steps.some((s: { type: string }) => s.type === 'record-decision')).toBe(true);
  });

  it('Verify phase contains a pr.doctor action and record-decision', () => {
    const verify = template.phases[2];
    const types = verify.steps.map((s: { type: string }) => s.type);
    expect(types).toContain('action');
    expect(types).toContain('record-decision');
    const doctorStep = verify.steps.find((s: { actionId?: string }) => s.actionId === 'pr.merge');
    expect(doctorStep).toBeUndefined();
  });

  it('passes validateWorkflowTemplate', () => {
    expect(validateWorkflowTemplate(template)).toEqual([]);
  });

  it('has low riskLevel', () => {
    expect(template.riskLevel).toBe('low');
  });
});

describe('enriched template metadata', () => {
  const enrichableIds = ['bugfix', 'feature', 'incident', 'release', 'research', 'docs'];

  for (const id of enrichableIds) {
    describe(`${id}.yaml`, () => {
      const filename = `${id}.yaml`;
      const template = loadTemplate(filename);

      it('has a non-empty description', () => {
        expect(typeof template.description).toBe('string');
        expect(template.description.length).toBeGreaterThan(0);
      });

      it('has a valid riskLevel', () => {
        const validLevels = ['none', 'low', 'medium', 'high'];
        expect(validLevels).toContain(template.riskLevel);
      });

      it('has tags array with at least one tag', () => {
        expect(Array.isArray(template.tags)).toBe(true);
        expect(template.tags.length).toBeGreaterThan(0);
      });

      it('all inputs have descriptions', () => {
        for (const input of template.inputs ?? []) {
          expect(typeof input.description).toBe('string');
          expect(input.description.length).toBeGreaterThan(0);
        }
      });
    });
  }
});
