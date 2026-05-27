// @openslack/tui — Public API
// Ink engine is internal; only render functions and types are exported.

export { default as render, renderSync, createRoot } from './ink/root.js';
export type { Instance, RenderOptions, Root } from './ink/root.js';

export { default as Box } from './ink/components/Box.js';
export { default as Text } from './ink/components/Text.js';
export { default as Newline } from './ink/components/Newline.js';
export { default as Spacer } from './ink/components/Spacer.js';

export { default as useApp } from './ink/hooks/use-app.js';
export { default as useInput } from './ink/hooks/use-input.js';
export { default as useStdin } from './ink/hooks/use-stdin.js';
export { useInterval } from './ink/hooks/use-interval.js';

// Design system
export { themes, resolveTheme } from './design-system/theme.js';
export type { Theme, ThemeMode, ThemeColorKey } from './design-system/theme.js';
export { ThemeProvider, useTheme } from './design-system/ThemeProvider.js';
export { default as ThemedBox } from './design-system/ThemedBox.js';
export type { ThemedBoxProps } from './design-system/ThemedBox.js';
export { default as ThemedText } from './design-system/ThemedText.js';
export type { ThemedTextProps } from './design-system/ThemedText.js';
export { default as StatusIcon, categorizeStatus } from './design-system/StatusIcon.js';
export type { StatusCategory, StatusIconProps } from './design-system/StatusIcon.js';
export { default as ProgressBar } from './design-system/ProgressBar.js';
export type { ProgressBarProps } from './design-system/ProgressBar.js';
export { default as Divider } from './design-system/Divider.js';
export type { DividerProps } from './design-system/Divider.js';
export { default as ListItem } from './design-system/ListItem.js';
export type { ListItemProps } from './design-system/ListItem.js';
export { default as Pane } from './design-system/Pane.js';
export type { PaneProps } from './design-system/Pane.js';
export { default as KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
export type { KeyboardShortcutHintProps } from './design-system/KeyboardShortcutHint.js';

// Infrastructure
export { isTuiSupported } from './capabilities.js';
export { sanitizeTerminalText } from './sanitize.js';
export { renderTui } from './render.js';
export type { RenderTuiOptions } from './render.js';

// Views
export { renderDashboardTui } from './views/render-dashboard.js';
export type { DashboardViewModel } from './view-models/dashboard.js';
export { renderDoctorTui } from './views/render-doctor.js';
export type { DoctorViewModel } from './view-models/doctor.js';
