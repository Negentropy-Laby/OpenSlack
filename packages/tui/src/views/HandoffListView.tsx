import React, { useCallback } from 'react';
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
import useApp from '../ink/hooks/use-app.js';
import useInput from '../ink/hooks/use-input.js';
import ThemedText from '../design-system/ThemedText.js';
import Divider from '../design-system/Divider.js';
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js';
import SelectableList from '../design-system/SelectableList.js';
import type { HandoffListViewModel, HandoffListItemViewModel } from '../view-models/handoff.js';

export type HandoffListViewProps = {
  model: HandoffListViewModel;
  onSelect?: (item: HandoffListItemViewModel) => void;
  onBack?: () => void;
};

export default function HandoffListView({
  model,
  onSelect,
  onBack,
}: HandoffListViewProps): React.JSX.Element {
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
      model.openCount > 0
        ? React.createElement(ThemedText, { colorTheme: 'warning' }, `${model.openCount} open`)
        : React.createElement(ThemedText, { colorTheme: 'pass' }, 'All closed'),
    ),
    React.createElement(Divider, { length: 40 }),

    // List
    model.items.length > 0
      ? React.createElement(SelectableList, {
          items: model.items.map((item) => ({
            key: item.id,
            label: `${item.from} → ${item.to}`,
            detail: `${item.context.slice(0, 50)}${item.context.length > 50 ? '...' : ''} · ${item.age} · ${item.ref}`,
          })),
          onSelect: handleSelect,
        })
      : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No handoffs found.'),

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
