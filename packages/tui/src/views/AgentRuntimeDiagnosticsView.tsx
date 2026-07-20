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
import type { AgentRuntimeDiagnosticsViewModel } from '../view-models/agent-runtime.js';

export interface AgentRuntimeDiagnosticsViewProps {
  model: AgentRuntimeDiagnosticsViewModel;
  onBack?: () => void;
}

function statusCategory(status: string): 'pass' | 'fail' | 'warn' | 'info' {
  if (status === 'PASS') return 'pass';
  if (status === 'FAIL') return 'fail';
  if (status === 'WARN') return 'warn';
  return 'info';
}

function keyList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

function compact(value: string, max = 72): string {
  if (value.length <= max) return value;
  const keep = Math.max(max - 5, 10);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
}

export default function AgentRuntimeDiagnosticsView({
  model,
  onBack,
}: AgentRuntimeDiagnosticsViewProps): React.JSX.Element {
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
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(StatusIcon, { category: statusCategory(model.status) }),
      React.createElement(Text, null, ' '),
      React.createElement(
        ThemedText,
        { colorTheme: 'accent', bold: true },
        `Agent Runtime / ${model.provider}`,
      ),
    ),
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Pane,
      { title: 'Configuration', marginY: 0 },
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(ThemedText, { colorTheme: 'foreground' }, `Status: ${model.status}`),
        model.readiness
          ? React.createElement(
              ThemedText,
              { colorTheme: 'foreground' },
              `Readiness: ${model.readiness}`,
            )
          : null,
        React.createElement(
          ThemedText,
          { colorTheme: 'foreground' },
          `Source: ${model.configSource}`,
        ),
        React.createElement(
          ThemedText,
          { colorTheme: 'foreground' },
          `Root: ${compact(model.root)}`,
        ),
        React.createElement(ThemedText, { colorTheme: 'foreground' }, `Command: ${model.command}`),
        React.createElement(
          ThemedText,
          { colorTheme: 'muted' },
          `Args: ${model.args.length > 0 ? compact(model.args.join(' ')) : 'not recorded'}`,
        ),
        React.createElement(ThemedText, { colorTheme: 'muted' }, `Timeout: ${model.timeoutMs}`),
        React.createElement(
          ThemedText,
          { colorTheme: 'muted' },
          `Config path: ${compact(model.configPath)}`,
        ),
      ),
    ),
    React.createElement(
      Pane,
      { title: 'Environment Audit', marginY: 0 },
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(
          ThemedText,
          { colorTheme: 'foreground' },
          `Allowed keys: ${keyList(model.safeEnvAllowed)}`,
        ),
        React.createElement(
          ThemedText,
          { colorTheme: model.safeEnvRejected.length > 0 ? 'error' : 'foreground' },
          `Rejected keys: ${keyList(model.safeEnvRejected)}`,
        ),
      ),
    ),
    React.createElement(
      Pane,
      { title: 'Checks', marginY: 0 },
      React.createElement(
        Box,
        { flexDirection: 'column' },
        ...model.checks.map((check) =>
          React.createElement(
            Box,
            { flexDirection: 'row', key: check.name },
            React.createElement(StatusIcon, { category: statusCategory(check.status) }),
            React.createElement(Text, null, ' '),
            React.createElement(
              ThemedText,
              { colorTheme: 'foreground' },
              compact(`${check.name}: ${check.detail}`),
            ),
          ),
        ),
      ),
    ),
    React.createElement(
      Pane,
      { title: 'Last Smoke', marginY: 0 },
      model.lastSmokeRun
        ? React.createElement(
            Box,
            { flexDirection: 'column' },
            React.createElement(
              ThemedText,
              { colorTheme: 'foreground' },
              `Run: ${model.lastSmokeRun.runId}`,
            ),
            React.createElement(
              ThemedText,
              { colorTheme: 'foreground' },
              `Status: ${model.lastSmokeRun.status}`,
            ),
            React.createElement(
              ThemedText,
              { colorTheme: 'muted' },
              `Started: ${model.lastSmokeRun.startedAt}`,
            ),
            React.createElement(
              ThemedText,
              { colorTheme: 'muted' },
              `Transcript: ${compact(model.lastSmokeRun.transcriptJsonl)}`,
            ),
          )
        : React.createElement(ThemedText, { colorTheme: 'muted' }, 'not recorded'),
    ),
    React.createElement(
      Pane,
      { title: 'Remediation', marginY: 0 },
      React.createElement(
        Box,
        { flexDirection: 'column' },
        ...model.remediations.map((line, index) =>
          React.createElement(
            ThemedText,
            { colorTheme: 'foreground', key: index },
            compact(`- ${line}`),
          ),
        ),
      ),
    ),
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
    ),
  );
}
