// Cleanup's selected installation ceiling, distinct from the broader delivery bot.
export const CLEANUP_APP_PERMISSIONS = Object.freeze({
  contents: 'write',
  pull_requests: 'read',
  issues: 'read',
  metadata: 'read',
} as const);
