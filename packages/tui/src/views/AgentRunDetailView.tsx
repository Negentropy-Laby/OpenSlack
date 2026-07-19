import React from 'react';
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
import useApp from '../ink/hooks/use-app.js';
import useInput from '../ink/hooks/use-input.js';
import Pane from '../design-system/Pane.js';
import ThemedText from '../design-system/ThemedText.js';
import Divider from '../design-system/Divider.js';
import StatusIcon from '../design-system/StatusIcon.js';
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js';
import type { AgentRunViewModel } from '../view-models/agent-run.js';
import type { AgentRunEvent } from '@openslack/agent-runtime';

export type AgentRunDetailViewProps = {
  model: AgentRunViewModel;
  onBack?: () => void;
};

function statusToCategory(status: string): 'pass' | 'fail' | 'warn' | 'info' {
  switch (status) {
    case 'completed':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'cancelled':
      return 'warn';
    case 'running':
      return 'info';
    default:
      return 'info';
  }
}

function eventIcon(type: string): string {
  switch (type) {
    case 'start':
      return '>';
    case 'progress':
      return '~';
    case 'tool_call':
      return '#';
    case 'tool_result':
      return '<';
    case 'complete':
      return '+';
    case 'fail':
      return '!';
    default:
      return '.';
  }
}

function eventSummary(e: AgentRunEvent): string {
  const toolName = String(e.data?.toolName ?? e.data?.tool ?? 'unknown');
  switch (e.type) {
    case 'start':
      return `started -- ${String(e.data?.agentId ?? 'agent')}`;
    case 'progress':
      return `step: ${String(e.data?.step ?? 'unknown')}`;
    case 'tool_call':
      return `tool: ${toolName}`;
    case 'tool_result':
      return `result: ${toolName}`;
    case 'complete':
      return `completed (${String(e.data?.tokenUsage ?? 0)} tokens)`;
    case 'fail':
      return `failed: ${String(e.data?.error ?? 'unknown error')}`;
    default:
      return e.type;
  }
}

export default function AgentRunDetailView({
  model,
  onBack,
}: AgentRunDetailViewProps): React.JSX.Element {
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (onBack) onBack();
      else exit();
    }
  });

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    // Header
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(StatusIcon, { category: statusToCategory(model.status) }),
      React.createElement(Text, null, ' '),
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `Run: ${model.runId}`),
    ),
    React.createElement(
      ThemedText,
      { colorTheme: 'muted', dim: true },
      `Agent: ${model.agentName}`,
    ),
    React.createElement(Divider, { length: 40 }),

    // Status section
    React.createElement(
      Pane,
      { title: 'Status', marginY: 0 },
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Status: '),
          React.createElement(ThemedText, { colorTheme: 'foreground' }, model.status),
        ),
        ...(model.model
          ? [
              React.createElement(
                Box,
                { flexDirection: 'row' },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'Model: '),
                React.createElement(ThemedText, { colorTheme: 'foreground' }, model.model),
              ),
            ]
          : []),
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Permission: '),
          React.createElement(ThemedText, { colorTheme: 'foreground' }, model.permissionMode),
        ),
      ),
    ),

    // Progress section
    React.createElement(
      Pane,
      { title: 'Progress', marginY: 0 },
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Tokens Used: '),
          React.createElement(ThemedText, { colorTheme: 'foreground' }, String(model.tokensUsed)),
        ),
        ...(model.tokensRemaining !== null
          ? [
              React.createElement(
                Box,
                { flexDirection: 'row' },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'Tokens Remaining: '),
                React.createElement(
                  ThemedText,
                  { colorTheme: 'foreground' },
                  String(model.tokensRemaining),
                ),
              ),
            ]
          : []),
        ...(model.lastTool
          ? [
              React.createElement(
                Box,
                { flexDirection: 'row' },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'Last Tool: '),
                React.createElement(ThemedText, { colorTheme: 'foreground' }, model.lastTool),
              ),
            ]
          : []),
      ),
    ),

    React.createElement(
      Pane,
      { title: 'Observability', marginY: 0 },
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Runtime: '),
          React.createElement(ThemedText, { colorTheme: 'foreground' }, model.runtimeProvider),
        ),
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Bridge Session: '),
          React.createElement(ThemedText, { colorTheme: 'foreground' }, model.bridgeSessionId),
        ),
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Terminal Reason: '),
          React.createElement(ThemedText, { colorTheme: 'foreground' }, model.terminalReason),
        ),
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'MCP Required: '),
          React.createElement(
            ThemedText,
            { colorTheme: 'foreground' },
            model.mcpRequired.length > 0 ? model.mcpRequired.join(', ') : 'none',
          ),
        ),
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'MCP Available: '),
          React.createElement(
            ThemedText,
            { colorTheme: 'foreground' },
            model.mcpAvailable.length > 0 ? model.mcpAvailable.join(', ') : 'none',
          ),
        ),
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Permission Denies: '),
          React.createElement(
            ThemedText,
            { colorTheme: 'foreground' },
            String(model.permissionDenies),
          ),
        ),
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Worktree Handoff: '),
          React.createElement(
            ThemedText,
            { colorTheme: 'foreground' },
            model.worktreeHandoffStatus,
          ),
        ),
      ),
    ),

    // Isolation section
    ...(model.worktreePath
      ? [
          React.createElement(
            Pane,
            { title: 'Isolation', marginY: 0 },
            React.createElement(
              Box,
              { flexDirection: 'column' },
              React.createElement(
                Box,
                { flexDirection: 'row' },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'Worktree: '),
                React.createElement(ThemedText, { colorTheme: 'foreground' }, model.worktreePath),
              ),
            ),
          ),
        ]
      : []),

    // Events timeline (max 20 most recent)
    ...(model.events.length > 0
      ? [
          React.createElement(
            Pane,
            { title: `Events (${model.events.length})`, marginY: 0 },
            React.createElement(
              Box,
              { flexDirection: 'column' },
              ...model.events.slice(-20).map((e, i) =>
                React.createElement(
                  Box,
                  { flexDirection: 'row', key: i },
                  React.createElement(
                    ThemedText,
                    {
                      colorTheme:
                        e.type === 'fail' ? 'error' : e.type === 'complete' ? 'success' : 'muted',
                    },
                    eventIcon(e.type),
                  ),
                  React.createElement(Text, null, ' '),
                  React.createElement(ThemedText, { colorTheme: 'foreground' }, eventSummary(e)),
                ),
              ),
            ),
          ),
        ]
      : [
          React.createElement(
            Pane,
            { title: 'Events', marginY: 0 },
            React.createElement(
              ThemedText,
              { colorTheme: 'muted' },
              'No transcript events available',
            ),
          ),
        ]),

    // Result / Error
    ...(model.error
      ? [
          React.createElement(
            Pane,
            { title: 'Error', marginY: 0 },
            React.createElement(ThemedText, { colorTheme: 'error' }, model.error),
          ),
        ]
      : model.result
        ? [
            React.createElement(
              Pane,
              { title: 'Result', marginY: 0 },
              React.createElement(ThemedText, { colorTheme: 'foreground' }, model.result),
            ),
          ]
        : []),

    // Transcript path
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, 'Transcript: '),
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, model.transcriptPath),
    ),

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
    ),
  );
}
