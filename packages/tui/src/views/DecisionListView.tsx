import React, { useCallback } from 'react';
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
import useApp from '../ink/hooks/use-app.js';
import useInput from '../ink/hooks/use-input.js';
import ThemedText from '../design-system/ThemedText.js';
import Divider from '../design-system/Divider.js';
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js';
import SelectableList from '../design-system/SelectableList.js';
import type { DecisionListViewModel, DecisionListItemViewModel } from '../view-models/decision.js';

export type DecisionListViewProps = {
  model: DecisionListViewModel;
  onSelect?: (item: DecisionListItemViewModel) => void;
  onBack?: () => void;
};

export default function DecisionListView({
  model,
  onSelect,
  onBack,
}: DecisionListViewProps): React.JSX.Element {
  const { exit } = useApp();

  const handleSelect = useCallback(
    (item: { key: string }) => {
      if (onSelect) {
        const found = model.items.find((i) => i.id === item.key);
        if (found) onSelect(found);
      }
    },
    [model.items, onSelect],
  );

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
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'foreground' }, `${model.totalCount} total`),
      React.createElement(Text, null, ' · '),
      model.activeCount > 0
        ? React.createElement(ThemedText, { colorTheme: 'pass' }, `${model.activeCount} active`)
        : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No active decisions'),
    ),
    React.createElement(Divider, { length: 40 }),

    // List
    model.items.length > 0
      ? React.createElement(SelectableList, {
          items: model.items.map((item) => ({
            key: item.id,
            label: item.topic,
            detail: `${item.decision.slice(0, 50)}${item.decision.length > 50 ? '...' : ''} · ${item.decidedBy} · ${item.age}`,
          })),
          onSelect: handleSelect,
        })
      : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No decisions found.'),

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['↑', '↓'], description: 'navigate' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Enter'], description: 'select' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
    ),
  );
}
