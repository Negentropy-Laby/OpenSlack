import { describe, expect, it } from 'vitest';
import { assertCleanTrackedStatus } from '../common.js';
import {
  qoderManifestFixture,
  qoderReceiptFixture,
  validateCredentialFreeConnectorConfig,
  validateQoderDesktopReceipt,
} from '../qoder-desktop.js';

const timestamp = '2026-07-29T00:00:00.000Z';

describe('Qoder Desktop qualification harness', () => {
  it('accepts no-prompt observations for the exact sealed read-only 12-tool catalog', () => {
    const manifest = qoderManifestFixture();
    const receipt = qoderReceiptFixture(manifest, timestamp);

    expect(validateQoderDesktopReceipt(receipt, manifest, timestamp)).toEqual(receipt);
  });

  it('accepts prompt observations for every stock tool', () => {
    const manifest = qoderManifestFixture();
    const receipt = qoderReceiptFixture(manifest, timestamp, 'prompt_observed');

    expect(validateQoderDesktopReceipt(receipt, manifest, timestamp)).toEqual(receipt);
  });

  it('rejects an incorrect tool order', () => {
    const manifest = qoderManifestFixture();
    const receipt = qoderReceiptFixture(manifest, timestamp);
    const calls = [...receipt.calls];
    [calls[0], calls[1]] = [calls[1]!, calls[0]!];

    expect(() => validateQoderDesktopReceipt({ ...receipt, calls }, manifest, timestamp)).toThrow(
      /tool order, result, blocker, or permission outcome evidence is invalid/,
    );
  });

  it('rejects a missing tool call', () => {
    const manifest = qoderManifestFixture();
    const receipt = qoderReceiptFixture(manifest, timestamp);

    expect(() =>
      validateQoderDesktopReceipt(
        { ...receipt, calls: receipt.calls.slice(0, -1) },
        manifest,
        timestamp,
      ),
    ).toThrow(/did not record every required tool call/);
  });

  it('rejects the wrong stale and unavailable blocker', () => {
    const manifest = qoderManifestFixture();
    const receipt = qoderReceiptFixture(manifest, timestamp);
    const stale = receipt.calls.map((call) =>
      call.name === 'openslack_query_graph'
        ? { ...call, blocker: 'SOURCE_EVIDENCE_UNAVAILABLE' }
        : call,
    );
    const unavailable = receipt.calls.map((call) =>
      call.name === 'openslack_explain_graph'
        ? { ...call, blocker: 'SOURCE_EVIDENCE_STALE' }
        : call,
    );

    expect(() =>
      validateQoderDesktopReceipt({ ...receipt, calls: stale }, manifest, timestamp),
    ).toThrow(/did not preserve SOURCE_EVIDENCE_STALE/);
    expect(() =>
      validateQoderDesktopReceipt({ ...receipt, calls: unavailable }, manifest, timestamp),
    ).toThrow(/did not preserve SOURCE_EVIDENCE_UNAVAILABLE/);
  });

  it.each([
    ['readOnlyHint', false],
    ['destructiveHint', true],
    ['idempotentHint', false],
    ['openWorldHint', true],
  ] as const)('rejects %s annotation drift', (field, value) => {
    const manifest = qoderManifestFixture();
    const toolAnnotations = manifest.toolAnnotations.map((binding, index) =>
      index === 0 ? { ...binding, [field]: value } : binding,
    );
    const driftedManifest = { ...manifest, toolAnnotations };
    const receipt = qoderReceiptFixture(driftedManifest, timestamp);

    expect(() => validateQoderDesktopReceipt(receipt, driftedManifest, timestamp)).toThrow(
      /exact reviewed read-only bindings/,
    );
  });

  it('rejects a mutation tool entering the stock catalog', () => {
    const manifest = qoderManifestFixture();
    const toolNames = [...manifest.toolNames];
    toolNames[11] = 'openslack_confirm_plan';
    const driftedManifest = { ...manifest, toolNames };
    const receipt = qoderReceiptFixture(driftedManifest, timestamp);

    expect(() => validateQoderDesktopReceipt(receipt, driftedManifest, timestamp)).toThrow(
      /manifest bindings are invalid/,
    );
  });

  it('rejects a legacy v1 receipt', () => {
    const manifest = qoderManifestFixture();
    const receipt = {
      ...qoderReceiptFixture(manifest, timestamp),
      schema: 'openslack.qoder_desktop_qualification_receipt.v1',
    };

    expect(() => validateQoderDesktopReceipt(receipt, manifest, timestamp)).toThrow(
      /root evidence is invalid/,
    );
  });

  it('rejects an unknown permission outcome', () => {
    const manifest = qoderManifestFixture();
    const receipt = qoderReceiptFixture(manifest, timestamp);
    const calls = receipt.calls.map((call, index) =>
      index === 0 ? { ...call, permissionOutcome: 'unknown' } : call,
    );

    expect(() => validateQoderDesktopReceipt({ ...receipt, calls }, manifest, timestamp)).toThrow(
      /permission outcome evidence is invalid/,
    );
  });

  it.each([
    ['oldConnectorRemoved', false],
    ['oldGrantsRemoved', false],
    ['connectorExplicitlyEnabled', false],
    ['autoRunDisabled', false],
    ['wildcard', true],
  ] as const)('rejects invalid %s permission evidence', (field, value) => {
    const manifest = qoderManifestFixture();
    const receipt = qoderReceiptFixture(manifest, timestamp);

    expect(() =>
      validateQoderDesktopReceipt(
        {
          ...receipt,
          permissions: { ...receipt.permissions, [field]: value },
        },
        manifest,
        timestamp,
      ),
    ).toThrow(/root evidence is invalid/);
  });

  it('rejects dirty tracked checkout evidence', () => {
    expect(() => assertCleanTrackedStatus(' M packages/qoder-adapter/src/index.ts\n')).toThrow(
      /no tracked changes/,
    );
  });

  it('rejects credential-like material in an otherwise stock connector config', () => {
    const config = {
      mcpServers: {
        openslack: {
          type: 'stdio',
          command: 'C:\\Tools\\bun.exe',
          args: ['--cwd=Bearer sensitive-value', 'run', 'openslack', 'mcp', 'serve', '--stdio'],
        },
      },
    };

    expect(() => validateCredentialFreeConnectorConfig(config)).toThrow(
      /credential-like(?: or remote)? material/,
    );
  });

  it.each(['alwaysAllow', 'permissions'] as const)(
    'rejects the unsupported %s connector control',
    (field) => {
      const config = {
        mcpServers: {
          openslack: {
            type: 'stdio',
            command: 'C:\\Tools\\bun.exe',
            args: ['--cwd=C:\\OpenSlack', 'run', 'openslack', 'mcp', 'serve', '--stdio'],
            [field]: [],
          },
        },
      };

      expect(() => validateCredentialFreeConnectorConfig(config)).toThrow(
        /OpenSlack connector has missing or unknown fields/,
      );
    },
  );

  it('rejects an incomplete Skill trigger', () => {
    const manifest = qoderManifestFixture();
    const receipt = qoderReceiptFixture(manifest, timestamp);

    expect(() =>
      validateQoderDesktopReceipt(
        { ...receipt, skillTriggers: receipt.skillTriggers.slice(0, 2) },
        manifest,
        timestamp,
      ),
    ).toThrow(/did not record every Skill trigger/);
  });
});
