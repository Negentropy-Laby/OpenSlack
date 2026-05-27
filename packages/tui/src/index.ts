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
