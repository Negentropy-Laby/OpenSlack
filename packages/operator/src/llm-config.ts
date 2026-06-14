/**
 * Describes LLM routing config status without exposing secret values.
 *
 * SECURITY: This module must NEVER include the API key value in its output.
 */
import { getLLMPlannerProvider } from './llm.js';

export interface LLMConfigStatus {
  mode: 'llm-first' | 'keyword-only' | 'misconfigured';
  provider?: string;
  model?: string;
  baseUrl?: string;
  hasApiKey: boolean;
  issues?: string[];
}

function isBuiltInProvider(provider: string): boolean {
  return provider === 'openai' || provider === 'openai-compatible';
}

/**
 * Inspect the environment and return a safe description of the LLM routing
 * configuration. The API key value is never included in the result.
 *
 * @param env - Environment variable map (typically `process.env`).
 */
export function describeLLMRoutingConfig(
  env: Record<string, string | undefined>,
): LLMConfigStatus {
  const provider = env.OPENSLACK_LLM_PROVIDER;
  const apiKey = env.OPENSLACK_LLM_API_KEY;
  const model = env.OPENSLACK_LLM_MODEL;
  const hasApiKey = !!apiKey;
  const hasModel = !!model;

  let mode: LLMConfigStatus['mode'];
  const issues: string[] = [];

  if (provider) {
    if (isBuiltInProvider(provider)) {
      if (!hasApiKey) {
        issues.push('OPENSLACK_LLM_API_KEY not set');
      }
      if (!hasModel) {
        issues.push('OPENSLACK_LLM_MODEL not set');
      }
    } else if (!getLLMPlannerProvider(provider)) {
      issues.push(`LLM provider not registered: ${provider}`);
    }

    if (issues.length === 0) {
      mode = 'llm-first';
    } else {
      mode = 'misconfigured';
    }
  } else {
    mode = 'keyword-only';
  }

  // Extract only the origin (protocol + host) from the base URL
  let baseUrl: string | undefined;
  const rawUrl = env.OPENSLACK_LLM_BASE_URL;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      baseUrl = parsed.origin;
    } catch {
      // Invalid URL — omit baseUrl entirely
    }
  }

  const result: LLMConfigStatus = {
    mode,
    hasApiKey,
  };

  if (provider) {
    result.provider = provider;
  }

  if (model) {
    result.model = model;
  }

  if (baseUrl) {
    result.baseUrl = baseUrl;
  }

  if (issues.length > 0) {
    result.issues = issues;
  }

  return result;
}
