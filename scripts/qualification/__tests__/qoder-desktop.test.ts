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
  it('accepts the exact 12-tool order, blockers, per-tool permissions, and three Skill triggers', () => {
    const manifest = qoderManifestFixture();
    const receipt = qoderReceiptFixture(manifest, timestamp);

    expect(validateQoderDesktopReceipt(receipt, manifest, timestamp)).toEqual(receipt);
  });

  it('rejects an incorrect tool order', () => {
    const manifest = qoderManifestFixture();
    const receipt = qoderReceiptFixture(manifest, timestamp);
    const calls = [...receipt.calls];
    [calls[0], calls[1]] = [calls[1]!, calls[0]!];

    expect(() => validateQoderDesktopReceipt({ ...receipt, calls }, manifest, timestamp)).toThrow(
      /tool order, result, blocker, or permission evidence is invalid/,
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

  it('rejects wildcard permission and an incomplete Skill trigger', () => {
    const manifest = qoderManifestFixture();
    const receipt = qoderReceiptFixture(manifest, timestamp);

    expect(() =>
      validateQoderDesktopReceipt(
        { ...receipt, permissions: { ...receipt.permissions, wildcard: true } },
        manifest,
        timestamp,
      ),
    ).toThrow(/root evidence is invalid/);
    expect(() =>
      validateQoderDesktopReceipt(
        { ...receipt, skillTriggers: receipt.skillTriggers.slice(0, 2) },
        manifest,
        timestamp,
      ),
    ).toThrow(/did not record every Skill trigger/);
  });
});
