import { describe, it, expect } from 'vitest';
import { validateWorkflowTemplate } from '../workflow.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getRegisteredAction } from '@openslack/operator';

const WORKFLOWS_DIR = join(process.cwd(), 'templates/workflows');

describe('built-in workflow templates', () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yaml'));

  it('has at least 6 templates', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
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
          }
        }
        for (const ref of inputRefs) {
          expect(inputNames.has(ref)).toBe(true);
        }
      });
    });
  }
});
