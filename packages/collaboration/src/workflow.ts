import { executePlan, getRegisteredAction, createRegisteredStep } from '@openslack/operator';
import type { ActionPlan, PlanStep, RiskLevel } from '@openslack/operator';
import type { AgentPrincipal, AgentPermissionSnapshot } from '@openslack/kernel';
import { createHandoff, type Handoff } from './handoff.js';
import { recordDecision, type Decision } from './decision.js';
import { recordEvent } from './events.js';

export type WorkflowInputType = 'string' | 'integer' | 'boolean';

export interface WorkflowTemplateInput {
  name: string;
  type: WorkflowInputType;
  required?: boolean;
  default?: string | number | boolean;
}

export type WorkflowTemplateStep =
  | {
      type: 'action';
      title?: string;
      actionId: string;
      input?: Record<string, unknown>;
      command?: never;
    }
  | {
      type: 'decision-gate';
      title: string;
      requiredRole: string;
    }
  | {
      type: 'handoff';
      from: string;
      to: string;
      context: string;
      issueRef?: string;
      prRef?: string;
      nextSteps?: string[];
    }
  | {
      type: 'record-decision';
      topic: string;
      decision: string;
      rationale: string;
      decidedBy: string;
      tags?: string[];
    }
  | {
      type: 'wait';
      title: string;
      eventType?: string;
    };

export interface WorkflowTemplatePhase {
  name: string;
  steps: WorkflowTemplateStep[];
}

export interface WorkflowTemplate {
  schema: 'openslack.workflow_template.v1';
  id: string;
  name: string;
  inputs?: WorkflowTemplateInput[];
  phases: WorkflowTemplatePhase[];
}

export interface WorkflowPreviewStep {
  phase: string;
  type: WorkflowTemplateStep['type'];
  title: string;
  actionId?: string;
  sideEffects: boolean;
  requiresConfirmation: boolean;
  requiredRole?: string;
}

export interface WorkflowPreview {
  templateId: string;
  name: string;
  correlationId: string;
  steps: WorkflowPreviewStep[];
  errors: string[];
}

export interface WorkflowRunResult {
  templateId: string;
  correlationId: string;
  status: 'completed' | 'blocked';
  preview: WorkflowPreview;
  handoffs: Handoff[];
  decisions: Decision[];
  errors: string[];
}

function generateCorrelationId(templateId: string): string {
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `WF-${templateId}-${ts}-${rand}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceInput(value: unknown, type: WorkflowInputType): string | number | boolean | undefined {
  if (value === undefined) return undefined;
  if (type === 'integer') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(n) ? n : undefined;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }
  return typeof value === 'string' ? value : String(value);
}

function resolveInputs(template: WorkflowTemplate, provided: Record<string, unknown>): { values: Record<string, string | number | boolean>; errors: string[] } {
  const values: Record<string, string | number | boolean> = {};
  const errors: string[] = [];

  for (const input of template.inputs ?? []) {
    const raw = provided[input.name] ?? input.default;
    const coerced = coerceInput(raw, input.type);
    if (coerced === undefined && input.required) {
      errors.push(`Missing required input: ${input.name}`);
      continue;
    }
    if (coerced === undefined && raw !== undefined) {
      errors.push(`Invalid input type for ${input.name}: expected ${input.type}`);
      continue;
    }
    if (coerced !== undefined) values[input.name] = coerced;
  }

  return { values, errors };
}

function resolveTemplateValue(value: unknown, inputs: Record<string, string | number | boolean>): unknown {
  if (typeof value !== 'string') return value;
  const exact = value.match(/^{{\s*inputs\.([a-zA-Z0-9_-]+)\s*}}$/);
  if (exact) return inputs[exact[1]];
  return value.replace(/{{\s*inputs\.([a-zA-Z0-9_-]+)\s*}}/g, (_m, name: string) => String(inputs[name] ?? ''));
}

function resolveTemplateRecord(record: Record<string, unknown> | undefined, inputs: Record<string, string | number | boolean>): Record<string, string | number | boolean | undefined> {
  const resolved: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    const next = resolveTemplateValue(value, inputs);
    if (typeof next === 'string' || typeof next === 'number' || typeof next === 'boolean' || next === undefined) {
      resolved[key] = next;
    }
  }
  return resolved;
}

export function validateWorkflowTemplate(template: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(template)) return ['Template must be an object'];
  if (template.schema !== 'openslack.workflow_template.v1') errors.push('schema must be openslack.workflow_template.v1');
  if (typeof template.id !== 'string' || template.id.length === 0) errors.push('id is required');
  if (typeof template.name !== 'string' || template.name.length === 0) errors.push('name is required');
  if (!Array.isArray(template.phases) || template.phases.length === 0) errors.push('phases must be a non-empty array');

  if (Array.isArray(template.phases)) {
    for (const [phaseIndex, phase] of template.phases.entries()) {
      if (!isRecord(phase)) {
        errors.push(`phase ${phaseIndex + 1} must be an object`);
        continue;
      }
      if (typeof phase.name !== 'string') errors.push(`phase ${phaseIndex + 1} name is required`);
      if (!Array.isArray(phase.steps)) {
        errors.push(`phase ${phaseIndex + 1} steps must be an array`);
        continue;
      }
      for (const [stepIndex, step] of phase.steps.entries()) {
        if (!isRecord(step)) {
          errors.push(`phase ${phaseIndex + 1} step ${stepIndex + 1} must be an object`);
          continue;
        }
        if (typeof step.command === 'string') errors.push(`phase ${phaseIndex + 1} step ${stepIndex + 1} cannot use raw command`);
        if (step.type === 'action') {
          if (typeof step.actionId !== 'string' || !getRegisteredAction(step.actionId)) {
            errors.push(`phase ${phaseIndex + 1} step ${stepIndex + 1} uses unknown action`);
          }
        } else if (!['decision-gate', 'handoff', 'record-decision', 'wait'].includes(String(step.type))) {
          errors.push(`phase ${phaseIndex + 1} step ${stepIndex + 1} has unsupported type`);
        }
      }
    }
  }

  return errors;
}

function riskRank(risk: RiskLevel): number {
  return ({ none: 0, low: 1, medium: 2, high: 3 } as Record<RiskLevel, number>)[risk];
}

function maxRisk(steps: PlanStep[]): RiskLevel {
  let current: RiskLevel = 'none';
  for (const step of steps) {
    const action = step.actionId ? getRegisteredAction(step.actionId) : undefined;
    if (action && riskRank(action.riskLevel) > riskRank(current)) current = action.riskLevel;
  }
  return current;
}

function buildPlan(template: WorkflowTemplate, actionStep: PlanStep): ActionPlan {
  const risk = maxRisk([actionStep]);
  return {
    goal: `${template.name}: ${actionStep.description}`,
    intent: { kind: 'unknown', slots: {}, confidence: 1 },
    steps: [actionStep],
    riskLevel: risk,
    missingParams: [],
    requiresConfirmation: actionStep.confirmationRequired,
    sideEffects: Boolean(actionStep.actionId && getRegisteredAction(actionStep.actionId)?.sideEffects),
  };
}

export function previewWorkflowTemplate(
  template: WorkflowTemplate,
  providedInputs: Record<string, unknown> = {},
  correlationId: string = generateCorrelationId(template.id),
): WorkflowPreview {
  const errors = validateWorkflowTemplate(template);
  const resolvedInputs = resolveInputs(template, providedInputs);
  errors.push(...resolvedInputs.errors);

  const steps: WorkflowPreviewStep[] = [];
  if (errors.length === 0) {
    for (const phase of template.phases) {
      for (const rawStep of phase.steps) {
        if (rawStep.type === 'action') {
          try {
            const step = createRegisteredStep(rawStep.actionId, resolveTemplateRecord(rawStep.input, resolvedInputs.values), `preview-${steps.length + 1}`);
            const action = getRegisteredAction(rawStep.actionId);
            steps.push({
              phase: phase.name,
              type: 'action',
              title: rawStep.title ?? step.description,
              actionId: rawStep.actionId,
              sideEffects: Boolean(action?.sideEffects),
              requiresConfirmation: step.confirmationRequired,
            });
          } catch (err) {
            errors.push((err as Error).message);
          }
        } else {
          steps.push({
            phase: phase.name,
            type: rawStep.type,
            title: rawStep.type === 'wait' ? rawStep.title : rawStep.type === 'decision-gate' ? rawStep.title : rawStep.type,
            sideEffects: rawStep.type === 'handoff' || rawStep.type === 'record-decision',
            requiresConfirmation: rawStep.type === 'decision-gate',
            requiredRole: rawStep.type === 'decision-gate' ? rawStep.requiredRole : undefined,
          });
        }
      }
    }
  }

  return { templateId: template.id, name: template.name, correlationId, steps, errors };
}

export async function executeWorkflowTemplate(
  template: WorkflowTemplate,
  providedInputs: Record<string, unknown> = {},
  options: { dryRun?: boolean; correlationId?: string; principal?: AgentPrincipal; snapshot?: AgentPermissionSnapshot } = {},
): Promise<WorkflowRunResult> {
  const correlationId = options.correlationId ?? generateCorrelationId(template.id);
  const preview = previewWorkflowTemplate(template, providedInputs, correlationId);
  const errors = [...preview.errors];
  const handoffs: Handoff[] = [];
  const decisions: Decision[] = [];

  recordEvent({
    type: 'workflow.previewed',
    actor: { id: 'workflow', kind: 'system', provider: 'cli' },
    object: { kind: 'workflow', id: template.id },
    source: { kind: 'openslack', ref: 'workflow.preview' },
    summary: `Workflow previewed: ${template.name}`,
    visibility: 'local',
    redacted: false,
    containsSensitiveData: false,
    correlationId,
  });

  if (errors.length > 0) {
    recordEvent({
      type: 'workflow.blocked',
      actor: { id: 'workflow', kind: 'system', provider: 'cli' },
      object: { kind: 'workflow', id: template.id },
      source: { kind: 'openslack', ref: 'workflow.validate' },
      summary: errors.join('; '),
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      correlationId,
      severity: 'warning',
      nextAction: { owner: 'human', action: 'Fix workflow template validation errors' },
    });
    return { templateId: template.id, correlationId, status: 'blocked', preview, handoffs, decisions, errors };
  }

  recordEvent({
    type: 'workflow.started',
    actor: { id: 'workflow', kind: 'system', provider: 'cli' },
    object: { kind: 'workflow', id: template.id },
    source: { kind: 'openslack', ref: 'workflow.execute' },
    summary: `Workflow started: ${template.name}`,
    visibility: 'local',
    redacted: false,
    containsSensitiveData: false,
    correlationId,
  });

  const resolvedInputs = resolveInputs(template, providedInputs).values;
  for (const phase of template.phases) {
    for (const rawStep of phase.steps) {
      if (rawStep.type === 'action') {
        const step = createRegisteredStep(rawStep.actionId, resolveTemplateRecord(rawStep.input, resolvedInputs), `s${preview.steps.length + 1}`);
        const result = await executePlan(buildPlan(template, step), { dryRun: options.dryRun, principal: options.principal, snapshot: options.snapshot });
        if (result.status === 'failed' || result.status === 'blocked' || result.status === 'cancelled') {
          errors.push(result.summary);
          recordEvent({
            type: 'workflow.blocked',
            actor: { id: 'workflow', kind: 'system', provider: 'cli' },
            object: { kind: 'workflow', id: template.id },
            source: { kind: 'openslack', ref: rawStep.actionId },
            summary: result.summary,
            visibility: 'local',
            redacted: false,
            containsSensitiveData: false,
            correlationId,
            severity: 'warning',
          });
          return { templateId: template.id, correlationId, status: 'blocked', preview, handoffs, decisions, errors };
        }
      } else if (rawStep.type === 'handoff' && !options.dryRun) {
        handoffs.push(createHandoff(rawStep));
      } else if (rawStep.type === 'record-decision' && !options.dryRun) {
        decisions.push(recordDecision(rawStep));
      }
    }
  }

  recordEvent({
    type: 'workflow.completed',
    actor: { id: 'workflow', kind: 'system', provider: 'cli' },
    object: { kind: 'workflow', id: template.id },
    source: { kind: 'openslack', ref: 'workflow.execute' },
    summary: `Workflow completed: ${template.name}`,
    visibility: 'local',
    redacted: false,
    containsSensitiveData: false,
    correlationId,
  });

  return { templateId: template.id, correlationId, status: 'completed', preview, handoffs, decisions, errors };
}

export function renderWorkflowPreview(preview: WorkflowPreview): string {
  const lines: string[] = [];
  lines.push(`Workflow: ${preview.name}`);
  lines.push(`Template: ${preview.templateId}`);
  lines.push(`Correlation: ${preview.correlationId}`);
  lines.push('');

  if (preview.errors.length > 0) {
    lines.push('Errors:');
    for (const error of preview.errors) lines.push(`- ${error}`);
    return lines.join('\n');
  }

  for (const step of preview.steps) {
    const flags = [
      step.sideEffects ? 'side-effect' : 'read-only',
      step.requiresConfirmation ? 'confirmation' : undefined,
      step.requiredRole ? `role:${step.requiredRole}` : undefined,
    ].filter(Boolean).join(', ');
    lines.push(`- [${step.phase}] ${step.title}${flags ? ` (${flags})` : ''}`);
  }

  return lines.join('\n');
}
