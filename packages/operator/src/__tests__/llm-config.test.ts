import { afterEach, describe, it, expect } from 'vitest';
import {
  clearLLMPlannerProviders,
  describeLLMRoutingConfig,
  registerLLMPlannerProvider,
} from '../index.js';

afterEach(() => {
  clearLLMPlannerProviders();
});

describe('describeLLMRoutingConfig', () => {
  it('returns keyword-only when no provider configured', () => {
    const result = describeLLMRoutingConfig({});

    expect(result.mode).toBe('keyword-only');
    expect(result.hasApiKey).toBe(false);
  });

  it('returns llm-first when provider and api key are set', () => {
    const result = describeLLMRoutingConfig({
      OPENSLACK_LLM_PROVIDER: 'openai-compatible',
      OPENSLACK_LLM_API_KEY: 'sk-test',
      OPENSLACK_LLM_MODEL: 'gpt-4',
      OPENSLACK_LLM_BASE_URL: 'https://api.openai.com/v1',
    });

    expect(result.mode).toBe('llm-first');
    expect(result.provider).toBe('openai-compatible');
    expect(result.model).toBe('gpt-4');
    expect(result.hasApiKey).toBe(true);
    // baseUrl must be the origin only, not the full path
    expect(result.baseUrl).toBe('https://api.openai.com');
  });

  it('returns misconfigured when provider set but api key missing', () => {
    const result = describeLLMRoutingConfig({
      OPENSLACK_LLM_PROVIDER: 'openai-compatible',
      OPENSLACK_LLM_MODEL: 'gpt-4',
    });

    expect(result.mode).toBe('misconfigured');
    expect(result.issues).toContain('OPENSLACK_LLM_API_KEY not set');
  });

  it('returns misconfigured when built-in provider is missing model', () => {
    const result = describeLLMRoutingConfig({
      OPENSLACK_LLM_PROVIDER: 'openai-compatible',
      OPENSLACK_LLM_API_KEY: 'sk-test',
    });

    expect(result.mode).toBe('misconfigured');
    expect(result.issues).toContain('OPENSLACK_LLM_MODEL not set');
  });

  it('reports both missing API key and model for built-in providers', () => {
    const result = describeLLMRoutingConfig({
      OPENSLACK_LLM_PROVIDER: 'openai',
    });

    expect(result.mode).toBe('misconfigured');
    expect(result.issues).toEqual([
      'OPENSLACK_LLM_API_KEY not set',
      'OPENSLACK_LLM_MODEL not set',
    ]);
  });

  it('returns llm-first for a registered custom provider without OpenAI credentials', () => {
    registerLLMPlannerProvider({
      id: 'local-mock',
      async classifyAndPlan() {
        return { intent: { kind: 'status', slots: {}, confidence: 1 } };
      },
    });

    const result = describeLLMRoutingConfig({
      OPENSLACK_LLM_PROVIDER: 'local-mock',
    });

    expect(result.mode).toBe('llm-first');
    expect(result.provider).toBe('local-mock');
    expect(result.hasApiKey).toBe(false);
    expect(result.issues).toBeUndefined();
  });

  it('returns misconfigured for an unregistered custom provider', () => {
    const result = describeLLMRoutingConfig({
      OPENSLACK_LLM_PROVIDER: 'missing-provider',
    });

    expect(result.mode).toBe('misconfigured');
    expect(result.issues).toEqual(['LLM provider not registered: missing-provider']);
  });

  it('never exposes API key value in output', () => {
    const result = describeLLMRoutingConfig({
      OPENSLACK_LLM_PROVIDER: 'openai-compatible',
      OPENSLACK_LLM_API_KEY: 'sk-super-secret-key-12345',
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk-super-secret-key-12345');
  });

  it('handles invalid baseUrl gracefully', () => {
    const result = describeLLMRoutingConfig({
      OPENSLACK_LLM_PROVIDER: 'openai-compatible',
      OPENSLACK_LLM_API_KEY: 'test',
      OPENSLACK_LLM_BASE_URL: 'not-a-url',
    });

    expect(result.baseUrl).toBeUndefined();
  });
});
