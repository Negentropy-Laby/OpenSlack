import type { WorkflowPreview } from '@openslack/collaboration';
import { sanitizeTerminalText } from '../sanitize.js';

export interface WorkflowPreviewStepViewModel {
  phase: string;
  type: string;
  title: string;
  actionId: string;
  sideEffects: boolean;
  requiresConfirmation: boolean;
  requiredRole: string;
}

export interface WorkflowPreviewViewModel {
  templateId: string;
  name: string;
  correlationId: string;
  steps: WorkflowPreviewStepViewModel[];
  phases: string[];
  phaseCount: number;
  stepCount: number;
  hasSideEffects: boolean;
  requiresConfirmation: boolean;
  errors: string[];
  hasErrors: boolean;
}

export function mapWorkflowPreviewToViewModel(preview: WorkflowPreview): WorkflowPreviewViewModel {
  const phaseNames = [...new Set(preview.steps.map((s) => s.phase))];
  const hasSideEffects = preview.steps.some((s) => s.sideEffects);
  const requiresConfirmation = preview.steps.some((s) => s.requiresConfirmation);

  return {
    templateId: sanitizeTerminalText(preview.templateId),
    name: sanitizeTerminalText(preview.name),
    correlationId: sanitizeTerminalText(preview.correlationId),
    steps: preview.steps.map((s) => ({
      phase: sanitizeTerminalText(s.phase),
      type: s.type,
      title: sanitizeTerminalText(s.title),
      actionId: s.actionId ? sanitizeTerminalText(s.actionId) : '',
      sideEffects: s.sideEffects,
      requiresConfirmation: s.requiresConfirmation,
      requiredRole: s.requiredRole ? sanitizeTerminalText(s.requiredRole) : '',
    })),
    phases: phaseNames.map(sanitizeTerminalText),
    phaseCount: phaseNames.length,
    stepCount: preview.steps.length,
    hasSideEffects,
    requiresConfirmation,
    errors: preview.errors.map(sanitizeTerminalText),
    hasErrors: preview.errors.length > 0,
  };
}
