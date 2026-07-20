import React, { useState } from 'react';
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
import type { DoctorViewModel } from '../view-models/doctor.js';

export type DoctorViewProps = {
  model: DoctorViewModel;
};

function CompressedView({ model }: DoctorViewProps): React.JSX.Element {
  const canMerge = model.decision === 'READY_TO_MERGE';
  const failedGate = model.gates.find((g) => g.status === 'FAIL');

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    React.createElement(
      ThemedText,
      { colorTheme: 'accent', bold: true },
      `PR #${model.prNumber} Summary`,
    ),
    React.createElement(Divider, { length: 50 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'foreground', bold: true }, 'Can merge: '),
      React.createElement(
        ThemedText,
        { colorTheme: canMerge ? 'success' : 'error', bold: true },
        canMerge ? 'YES' : 'NO',
      ),
    ),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'foreground', bold: true }, 'Blocker: '),
      failedGate
        ? React.createElement(
            ThemedText,
            { colorTheme: 'error' },
            `${failedGate.name} - ${failedGate.detail}`,
          )
        : React.createElement(ThemedText, { colorTheme: 'success' }, 'No blockers'),
    ),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'foreground', bold: true }, 'Why: '),
      React.createElement(ThemedText, { colorTheme: 'muted' }, model.reason),
    ),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'foreground', bold: true }, 'Next: '),
      React.createElement(
        ThemedText,
        { colorTheme: 'accent' },
        `openslack pr doctor ${model.prNumber}`,
      ),
    ),
    React.createElement(Divider, { length: 40 }),
    React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, 'Press c for full view'),
  );
}

function FullView({ model }: DoctorViewProps): React.JSX.Element {
  const decisionCategory =
    model.decision === 'READY_TO_MERGE'
      ? ('pass' as const)
      : model.gates.some((g) => g.status === 'FAIL')
        ? ('fail' as const)
        : ('warn' as const);

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    // Header
    React.createElement(
      ThemedText,
      { colorTheme: 'accent', bold: true },
      `PR #${model.prNumber} Doctor Report`,
    ),
    React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, model.title),
    React.createElement(Divider, { length: 50 }),

    // PR metadata
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'foreground' }, `Author: @${model.author}`),
      React.createElement(Text, null, '  '),
      React.createElement(
        ThemedText,
        {
          colorTheme:
            model.riskZone === 'black' ? 'error' : model.riskZone === 'red' ? 'warning' : 'success',
        },
        `Risk: ${model.riskZone.toUpperCase()}`,
      ),
      React.createElement(Text, null, '  '),
      React.createElement(
        ThemedText,
        { colorTheme: model.draft ? 'error' : 'muted' },
        model.draft ? 'DRAFT' : model.state,
      ),
    ),
    React.createElement(Divider, { length: 40 }),

    // Gates
    React.createElement(
      Pane,
      { title: 'Gates', marginY: 0 },
      ...model.gates.map((g) =>
        React.createElement(ListItem, {
          key: g.name,
          label: g.name,
          detail: g.detail,
          status: g.status,
        }),
      ),
    ),

    // Profile Sync Gate pane (conditional)
    model.profileSyncGate
      ? React.createElement(
          Pane,
          { title: 'Profile Sync Gate', marginY: 0 },
          React.createElement(ListItem, {
            label: 'Profile Sync',
            detail: model.profileSyncGate.detail,
            status: model.profileSyncGate.passed ? 'PASS' : 'FAIL',
          }),
        )
      : null,

    // Decision
    React.createElement(
      Box,
      { flexDirection: 'row', marginY: 0 },
      React.createElement(StatusIcon, { category: decisionCategory }),
      React.createElement(Text, null, ' '),
      React.createElement(ThemedText, { colorTheme: 'foreground', bold: true }, model.decision),
    ),
    React.createElement(ThemedText, { colorTheme: 'muted' }, model.reason),

    // Checks
    model.checks.length > 0
      ? React.createElement(
          Pane,
          { title: 'Checks', marginY: 0 },
          ...model.checks.map((c) =>
            React.createElement(ListItem, {
              key: c.name,
              label: c.name,
              detail: c.conclusion,
              status: c.status,
            }),
          ),
        )
      : null,

    // Reviews
    model.reviews.length > 0
      ? React.createElement(
          Pane,
          { title: 'Reviews', marginY: 0 },
          ...model.reviews.map((r) =>
            React.createElement(ListItem, {
              key: r.user,
              label: `@${r.user}`,
              detail: `${r.state}${r.valid ? ' (valid)' : ''}`,
              status: r.valid ? 'PASS' : r.state === 'APPROVED' ? 'info' : 'FAIL',
            }),
          ),
        )
      : null,

    // Evidence
    model.evidence.length > 0
      ? React.createElement(
          Pane,
          { title: 'Evidence', marginY: 0 },
          ...model.evidence.map((e, i) =>
            React.createElement(ListItem, {
              key: `ev-${i}`,
              label: e,
              status: 'info',
            }),
          ),
        )
      : null,

    // Recommendation
    React.createElement(Divider, { length: 40 }),
    React.createElement(ThemedText, { colorTheme: 'warning' }, model.recommendation),

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['c'], description: 'summary' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'exit' }),
    ),
  );
}

export default function DoctorView({ model }: DoctorViewProps): React.JSX.Element {
  const { exit } = useApp();
  const [compressed, setCompressed] = useState(model.compressed);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit();
    } else if (input === 'c') {
      setCompressed((prev) => !prev);
    }
  });

  if (compressed) {
    return React.createElement(CompressedView, { model });
  }

  return React.createElement(FullView, { model });
}
