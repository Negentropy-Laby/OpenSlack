// Stub: Aby REPL performance hooks.
// OpenSlack TUI is render-and-exit or bounded interactive — no scroll tracking
// or interaction timing needed. Safe to no-op.

export function flushInteractionTime(): void {}
export function markScrollActivity(): void {}
export function updateLastInteractionTime(): void {}
