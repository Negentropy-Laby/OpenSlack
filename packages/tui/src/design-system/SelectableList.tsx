import React from 'react';
import Box from '../ink/components/Box.js';
import useInput from '../ink/hooks/use-input.js';
import { useClampedIndex } from '../hooks/use-clamped-index.js';
import ThemedText from './ThemedText.js';

export interface SelectableListItem {
  label: string;
  detail?: string;
  key: string;
}

export interface SelectableListProps {
  items: SelectableListItem[];
  onSelect: (item: SelectableListItem, index: number) => void;
  visibleRows?: number;
}

export default function SelectableList({
  items,
  onSelect,
  visibleRows = 10,
}: SelectableListProps): React.JSX.Element | null {
  const [selectedIndex, setSelectedIndex] = useClampedIndex(items.length);

  if (items.length === 0) return null;

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : items.length - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => (prev < items.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      onSelect(items[selectedIndex], selectedIndex);
    }
  });

  // Compute scroll window
  const needsScroll = items.length > visibleRows;
  let scrollOffset = 0;
  if (needsScroll) {
    // Keep selected item visible
    if (selectedIndex >= visibleRows) {
      scrollOffset = selectedIndex - visibleRows + 1;
    }
    // Clamp
    if (scrollOffset + visibleRows > items.length) {
      scrollOffset = items.length - visibleRows;
    }
  }

  const visibleItems = needsScroll ? items.slice(scrollOffset, scrollOffset + visibleRows) : items;

  const adjustedSelectedIndex = selectedIndex - scrollOffset;

  const rows = visibleItems.map((item, i) => {
    const isSelected = i === adjustedSelectedIndex;
    const pointer = isSelected ? '>' : ' ';

    const labelElement = isSelected
      ? React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, item.label)
      : React.createElement(ThemedText, { colorTheme: 'foreground' }, item.label);

    const detailElement = item.detail
      ? React.createElement(
          Box,
          { marginLeft: 3 },
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, item.detail),
        )
      : null;

    return React.createElement(
      Box,
      {
        key: item.key,
        flexDirection: 'column',
        onClick: () => {
          setSelectedIndex(scrollOffset + i);
          onSelect(items[scrollOffset + i], scrollOffset + i);
        },
        onMouseEnter: () => setSelectedIndex(scrollOffset + i),
      },
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(ThemedText, { colorTheme: isSelected ? 'accent' : 'muted' }, pointer),
        React.createElement(ThemedText, { colorTheme: 'foreground' }, ' '),
        labelElement,
      ),
      detailElement,
    );
  });

  // Scroll indicators
  const topIndicator =
    needsScroll && scrollOffset > 0
      ? React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, '  ...')
      : null;

  const bottomIndicator =
    needsScroll && scrollOffset + visibleRows < items.length
      ? React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, '  ...')
      : null;

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    topIndicator,
    ...rows,
    bottomIndicator,
  );
}
