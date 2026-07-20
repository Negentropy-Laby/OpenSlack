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
import type { DashboardViewModel } from '../view-models/dashboard.js';

export type DashboardViewProps = {
  model: DashboardViewModel;
  onBack?: () => void;
};

export default function DashboardView({ model, onBack }: DashboardViewProps): React.JSX.Element {
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
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, model.title),
    React.createElement(
      ThemedText,
      { colorTheme: 'muted', dim: true },
      `Generated: ${model.generatedAt}`,
    ),
    React.createElement(Divider, { length: 40 }),

    // Summary row
    React.createElement(
      Box,
      { flexDirection: 'row', marginY: 0 },
      React.createElement(StatusIcon, { category: model.summary.blockers > 0 ? 'fail' : 'pass' }),
      React.createElement(Text, null, ' '),
      React.createElement(
        ThemedText,
        { colorTheme: 'foreground' },
        `Blockers: ${model.summary.blockers}`,
      ),
      React.createElement(Text, null, '  '),
      React.createElement(StatusIcon, { category: 'info' }),
      React.createElement(Text, null, ' '),
      React.createElement(
        ThemedText,
        { colorTheme: 'foreground' },
        `Handoffs: ${model.summary.handoffs}`,
      ),
      React.createElement(Text, null, '  '),
      React.createElement(StatusIcon, { category: 'info' }),
      React.createElement(Text, null, ' '),
      React.createElement(
        ThemedText,
        { colorTheme: 'foreground' },
        `Decisions: ${model.summary.decisions}`,
      ),
    ),
    React.createElement(Divider, { length: 40 }),

    // Blockers
    model.blockers.length > 0
      ? React.createElement(
          Pane,
          { title: 'Blockers', marginY: 0 },
          ...model.blockers.map((b) =>
            React.createElement(ListItem, {
              key: b.object,
              label: `${b.object}: ${b.summary}`,
              detail: b.nextAction ? `Next: ${b.nextAction}` : undefined,
              status: 'FAIL',
            }),
          ),
        )
      : React.createElement(ThemedText, { colorTheme: 'pass' }, '✓ No blockers'),

    // Handoffs
    model.handoffs.length > 0
      ? React.createElement(
          Pane,
          { title: 'Open Handoffs', marginY: 0 },
          ...model.handoffs.map((h) =>
            React.createElement(ListItem, {
              key: h.id,
              label: `${h.from} → ${h.to} (${h.age})`,
              detail: h.context,
              status: h.status === 'open' ? 'WARN' : 'PASS',
            }),
          ),
        )
      : null,

    // Decisions
    model.decisions.length > 0
      ? React.createElement(
          Pane,
          { title: 'Active Decisions', marginY: 0 },
          ...model.decisions.map((d) =>
            React.createElement(ListItem, {
              key: d.id,
              label: d.topic,
              detail: `by ${d.decidedBy}`,
              status: 'PASS',
            }),
          ),
        )
      : null,

    // Recent Activity
    model.recentActivity.length > 0
      ? React.createElement(
          Pane,
          { title: 'Recent Activity', marginY: 0 },
          ...model.recentActivity.slice(0, 10).map((a, i) =>
            React.createElement(ListItem, {
              key: `${a.type}-${i}`,
              label: a.summary,
              detail: `${a.time} · ${a.actor}`,
              status: a.type.includes('blocked')
                ? 'FAIL'
                : a.type.includes('passed')
                  ? 'PASS'
                  : 'info',
            }),
          ),
        )
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
