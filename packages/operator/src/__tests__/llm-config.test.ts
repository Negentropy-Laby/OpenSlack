import { describe, it, expect } from 'vitest';
import { describeLLMRoutingConfig } from '../index.js';

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
