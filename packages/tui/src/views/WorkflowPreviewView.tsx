import React from 'react';
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
import useApp from '../ink/hooks/use-app.js';
import useInput from '../ink/hooks/use-input.js';
import Pane from '../design-system/Pane.js';
import ThemedText from '../design-system/ThemedText.js';
import ListItem from '../design-system/ListItem.js';
import Divider from '../design-system/Divider.js';
import StatusIcon from '../design-system/StatusIcon.js';
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js';
import type { WorkflowPreviewViewModel } from '../view-models/workflow-preview.js';

export type WorkflowPreviewViewProps = {
  model: WorkflowPreviewViewModel;
};

function stepStatus(
  model: WorkflowPreviewViewModel,
  step: WorkflowPreviewViewModel['steps'][number],
): 'PASS' | 'FAIL' | 'WARN' | 'info' {
  if (model.hasErrors) return 'FAIL';
  if (step.requiresConfirmation) return 'WARN';
  if (step.sideEffects) return 'info';
  return 'PASS';
}

export default function WorkflowPreviewView({
  model,
}: WorkflowPreviewViewProps): React.JSX.Element {
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit();
    }
  });

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    // Header
    React.createElement(
      ThemedText,
      { colorTheme: 'accent', bold: true },
      `Workflow: ${model.name}`,
    ),
    React.createElement(
      ThemedText,
      { colorTheme: 'muted', dim: true },
      `Template: ${model.templateId} | Correlation: ${model.correlationId}`,
    ),
    React.createElement(Divider, { length: 50 }),

    // Summary row
    React.createElement(
      Box,
      { flexDirection: 'row', marginY: 0 },
      React.createElement(StatusIcon, {
        category: model.hasErrors ? 'fail' : model.hasSideEffects ? 'warn' : 'pass',
      }),
      React.createElement(Text, null, ' '),
      React.createElement(ThemedText, { colorTheme: 'foreground' }, `${model.stepCount} steps`),
      React.createElement(Text, null, '  '),
      React.createElement(StatusIcon, { category: 'info' }),
      React.createElement(Text, null, ' '),
      React.createElement(ThemedText, { colorTheme: 'foreground' }, `${model.phaseCount} phases`),
      React.createElement(Text, null, '  '),
      React.createElement(StatusIcon, { category: model.hasSideEffects ? 'warn' : 'pass' }),
      React.createElement(Text, null, ' '),
      React.createElement(
        ThemedText,
        { colorTheme: 'foreground' },
        model.hasSideEffects ? 'Has side effects' : 'Read-only',
      ),
    ),
    model.requiresConfirmation
      ? React.createElement(
          Box,
          { flexDirection: 'row', marginY: 0 },
          React.createElement(StatusIcon, { category: 'warn' }),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'warning' }, 'Requires confirmation'),
        )
      : null,
    React.createElement(Divider, { length: 40 }),

    // Errors
    model.hasErrors
      ? React.createElement(
          Pane,
          { title: 'Errors', marginY: 0 },
          ...model.errors.map((error, i) =>
            React.createElement(ListItem, {
              key: `error-${i}`,
              label: error,
              status: 'FAIL',
            }),
          ),
        )
      : null,

    // Steps grouped by phase
    ...model.phases.map((phase) => {
      const phaseSteps = model.steps.filter((s) => s.phase === phase);
      return React.createElement(
        Pane,
        { key: phase, title: phase, marginY: 0 },
        ...phaseSteps.map((step, i) => {
          const flags: string[] = [];
          if (step.sideEffects) flags.push('side-effect');
          if (step.requiresConfirmation) flags.push('confirmation');
          if (step.requiredRole) flags.push(`role:${step.requiredRole}`);
          const detail = flags.length > 0 ? flags.join(', ') : 'read-only';
          return React.createElement(ListItem, {
            key: `${step.type}-${i}`,
            label: `${step.title}`,
            detail,
            status: stepStatus(model, step),
          });
        }),
      );
    }),

    // Empty state
    model.steps.length === 0 && !model.hasErrors
      ? React.createElement(ThemedText, { colorTheme: 'muted' }, 'No steps in this workflow.')
      : null,

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'exit' }),
    ),
  );
}
