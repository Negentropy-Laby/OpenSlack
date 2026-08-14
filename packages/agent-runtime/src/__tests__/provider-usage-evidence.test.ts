import { describe, expect, it } from 'vitest';
import {
  assertProviderUsageReceipt,
  assertProviderUsageEvidence,
  attachProviderUsageEvidence,
  buildProviderUsageIdentityHashes,
  buildProviderUsageReceipt,
  getProviderUsageEvidence,
  PROVIDER_USAGE_EVIDENCE_MAX_ENTRIES,
} from '../index.js';

function reportedReceipt() {
  return buildProviderUsageReceipt({
    providerId: 'openai-compatible',
    modelId: 'qualification-model',
    runId: 'RUN-20260814-USAGEEVIDENCE',
    attempt: 1,
    status: 'reported',
    usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
    outcome: 'provider_response_accepted',
    requestBytes: 'prompt and credential must not appear',
    outcomeBytes: 'provider response must not appear',
  });
}

describe('provider usage evidence', () => {
  it('builds deterministic canonical receipts without raw provider material', () => {
    const first = reportedReceipt();
    const second = reportedReceipt();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema: 'openslack.provider_usage_receipt.v1',
      attempt: '1',
      calls: '1',
      status: 'reported',
      inputTokens: '7',
      outputTokens: '5',
      totalTokens: '12',
      outcome: 'provider_response_accepted',
    });
    expect(first.receiptHash).toBe(
      'sha256:1e25c9c4393cf38f3d373fd5341b81fd03c509eff0e54e47797b0da075ca380a',
    );
    expect(first.providerHash).not.toBe(first.modelHash);
    expect(JSON.stringify(first)).not.toContain('openai-compatible');
    expect(JSON.stringify(first)).not.toContain('qualification-model');
    expect(JSON.stringify(first)).not.toContain('prompt and credential');
    expect(JSON.stringify(first)).not.toContain('provider response');
    expect(() => assertProviderUsageReceipt(first)).not.toThrow();
  });

  it('domain-separates identity, request, outcome, and receipt hashes', () => {
    const receipt = buildProviderUsageReceipt({
      providerId: 'same-preimage',
      modelId: 'same-preimage',
      runId: 'same-preimage',
      attempt: 1,
      status: 'unreported',
      usage: null,
      outcome: 'provider_attempt_failed',
      requestBytes: 'same-preimage',
      outcomeBytes: 'same-preimage',
    });

    expect(
      new Set([
        receipt.providerHash,
        receipt.modelHash,
        receipt.runHash,
        receipt.requestHash,
        receipt.outcomeHash,
        receipt.receiptHash,
      ]).size,
    ).toBe(6);
    expect(
      buildProviderUsageIdentityHashes('same-preimage', 'same-preimage', 'same-preimage'),
    ).toEqual({
      providerHash: receipt.providerHash,
      modelHash: receipt.modelHash,
      runHash: receipt.runHash,
    });
  });

  it('rejects non-canonical, inconsistent, and hash-drifted receipts', () => {
    const receipt = reportedReceipt();
    expect(() => assertProviderUsageReceipt({ ...receipt, totalTokens: '012' })).toThrow(
      /canonical/,
    );
    expect(() => assertProviderUsageReceipt({ ...receipt, totalTokens: '13' })).toThrow(
      /inconsistent/,
    );
    expect(() => assertProviderUsageReceipt({ ...receipt, attempt: '2' })).toThrow(/hash/);
    expect(() => assertProviderUsageReceipt({ ...receipt, provider: 'openai-compatible' })).toThrow(
      /fields/,
    );
  });

  it('rejects accessors, proxies, non-plain records, and oversized evidence without getters', () => {
    const receipt = reportedReceipt();
    let getterCalled = false;
    const accessor = { ...receipt };
    Object.defineProperty(accessor, 'status', {
      enumerable: true,
      get() {
        getterCalled = true;
        return 'reported';
      },
    });
    expect(() => assertProviderUsageReceipt(accessor)).toThrow(/data properties/);
    expect(getterCalled).toBe(false);
    expect(() => assertProviderUsageReceipt(new Proxy(receipt, {}))).toThrow(/non-proxied/);
    expect(() => assertProviderUsageReceipt(Object.assign(Object.create(null), receipt))).toThrow(
      /plain object/,
    );

    const tooMany = Array.from(
      { length: PROVIDER_USAGE_EVIDENCE_MAX_ENTRIES + 1 },
      (_entry, index) =>
        buildProviderUsageReceipt({
          providerId: 'openai-compatible',
          modelId: 'qualification-model',
          runId: 'RUN-20260814-USAGEEVIDENCE',
          attempt: index + 1,
          status: 'unreported',
          usage: null,
          outcome: 'provider_attempt_failed',
          requestBytes: String(index + 1),
          outcomeBytes: 'typed failure',
        }),
    );
    expect(() => assertProviderUsageEvidence(tooMany)).toThrow(/at most 32/);
  });

  it('carries validated ordered evidence on errors without serializing it', () => {
    const error = new Error('safe failure');
    const first = reportedReceipt();
    const second = buildProviderUsageReceipt({
      providerId: 'openai-compatible',
      modelId: 'qualification-model',
      runId: 'RUN-20260814-USAGEEVIDENCE',
      attempt: 2,
      status: 'unreported',
      usage: null,
      outcome: 'provider_attempt_failed',
      requestBytes: 'second request',
      outcomeBytes: 'typed failure only',
    });

    attachProviderUsageEvidence(error, [first, second]);

    expect(getProviderUsageEvidence(error)).toEqual([first, second]);
    expect(JSON.stringify(error)).toBe('{}');
    expect(Object.keys(error)).not.toContain('usageEvidence');
  });
});
