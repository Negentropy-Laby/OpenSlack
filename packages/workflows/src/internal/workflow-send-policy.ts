/** Additional campaign ceilings; the existing Go policy may be stricter. */
export const WORKFLOW_SEND_LIMITS = Object.freeze({
  attempts: 4,
  tokensPerAttempt: 8192,
  totalTokens: 32768,
} as const);
export const WORKFLOW_SEND_MAIN_CHAIN = Object.freeze(['initial', 'resume'] as const);
