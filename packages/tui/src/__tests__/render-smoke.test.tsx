/**
 * render-smoke.test.tsx — Real render smoke test
 *
 * Exercises the ink reconciler, layout (Yoga), and output pipeline
 * end-to-end by rendering a Box+Text tree into a mock writable stream
 * and asserting the rendered output contains the expected text.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { Writable } from 'stream';

describe('Real render smoke test', () => {
  let instance: { unmount: () => void; waitUntilExit: () => Promise<void> } | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  it('renders Box containing Text into a mock stdout', async () => {
    const tui = await import('@openslack/tui');

    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk: Buffer | string, _encoding: string, cb: () => void) {
        chunks.push(chunk.toString());
        cb();
      },
    }) as NodeJS.WriteStream;

    // The Ink constructor reads .columns, .rows, and .isTTY from stdout.
    // Provide sensible defaults for a non-TTY mock.
    Object.defineProperties(stdout, {
      columns: { value: 80, writable: true, configurable: true },
      rows: { value: 24, writable: true, configurable: true },
      isTTY: { value: false, configurable: true },
    });

    instance = await tui.render(
      React.createElement(tui.Box, null, React.createElement(tui.Text, null, 'Hello TUI')),
      { stdout, patchConsole: false },
    );

    // Give the reconciler and render pipeline a tick to flush output.
    await new Promise((r) => setTimeout(r, 150));

    const output = chunks.join('');
    expect(output).toContain('Hello TUI');
  }, 15000);

  it('renders multiple Text children inside a column Box', async () => {
    const tui = await import('@openslack/tui');

    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk: Buffer | string, _encoding: string, cb: () => void) {
        chunks.push(chunk.toString());
        cb();
      },
    }) as NodeJS.WriteStream;

    Object.defineProperties(stdout, {
      columns: { value: 80, writable: true, configurable: true },
      rows: { value: 24, writable: true, configurable: true },
      isTTY: { value: false, configurable: true },
    });

    instance = await tui.render(
      React.createElement(
        tui.Box,
        { flexDirection: 'column' },
        React.createElement(tui.Text, null, 'Line One'),
        React.createElement(tui.Text, null, 'Line Two'),
      ),
      { stdout, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 150));

    const output = chunks.join('');
    expect(output).toContain('Line One');
    expect(output).toContain('Line Two');
  }, 15000);

  it('maps profile-sync approval category in view model', async () => {
    const { mapApprovalCenterToViewModel, getCategoryLabel } =
      await import('../view-models/approval-center.js');

    const model = mapApprovalCenterToViewModel({
      pendingApprovals: [
        {
          id: 'ps-1',
          category: 'profile-sync',
          title: 'Sync org profile to remote',
          detail: 'Proposed profile sync for .github templates',
          risk: 'medium',
          requestedBy: 'profile-sync-robot',
          requestedAt: '2026-05-31T10:00:00Z',
          profileSyncAction: 'create-pr',
        },
        {
          id: 'mr-1',
          category: 'merge-request',
          title: 'Merge PR #42',
          risk: 'low',
          requestedBy: 'agent',
          requestedAt: '2026-05-31T09:00:00Z',
        },
      ],
    });

    // profile-sync item is present
    expect(model.pendingApprovals).toHaveLength(2);
    expect(model.pendingApprovals[0].category).toBe('profile-sync');
    expect(model.pendingApprovals[0].profileSyncAction).toBe('create-pr');

    // summary includes profileSyncs count
    expect(model.summary.profileSyncs).toBe(1);
    expect(model.summary.mergeRequests).toBe(1);

    // group ordering: merge-request, workflow-effect, profile-sync, plan, github-review
    expect(model.groups.map((g) => g.category)).toEqual(['merge-request', 'profile-sync']);

    // category label
    expect(getCategoryLabel('profile-sync')).toBe('Profile Sync');
  });

  it('keeps GitHub review approvals outside TUI confirmation actions', async () => {
    const { isTuiConfirmableApprovalCategory } = await import('../views/ApprovalCenterView.js');

    expect(isTuiConfirmableApprovalCategory('github-review')).toBe(false);
    expect(isTuiConfirmableApprovalCategory('plan')).toBe(true);
    expect(isTuiConfirmableApprovalCategory('merge-request')).toBe(true);
    expect(isTuiConfirmableApprovalCategory('workflow-effect')).toBe(true);
    expect(isTuiConfirmableApprovalCategory('profile-sync')).toBe(true);
  });

  it('maps profile view model with syncDetails and mode', async () => {
    const { mapProfileToViewModel } = await import('../view-models/profile.js');

    const model = mapProfileToViewModel({
      syncStatus: 'synced',
      mode: 'watch',
      syncDetails: {
        sourceCommit: 'def5678',
        sourceDate: '2026-05-29T08:00:00Z',
        targetHash: 'present',
        pendingPR: { number: 99, status: 'open' },
        lastSync: { timestamp: '2026-05-29', result: 'success' },
        mode: 'watch',
      },
    });

    expect(model.syncStatus).toBe('synced');
    expect(model.mode).toBe('watch');
    expect(model.syncDetails).toBeDefined();
    expect(model.syncDetails!.sourceCommit).toBe('def5678');
    expect(model.syncDetails!.sourceDate).toBe('2026-05-29T08:00:00Z');
    expect(model.syncDetails!.targetHash).toBe('present');
    expect(model.syncDetails!.pendingPR).toEqual({ number: 99, status: 'open' });
    expect(model.syncDetails!.lastSync).toEqual({ timestamp: '2026-05-29', result: 'success' });
    expect(model.syncDetails!.mode).toBe('watch');
    expect(model.failureDetails).toBeUndefined();
  });

  it('maps profile view model with failureDetails when sync failed', async () => {
    const { mapProfileToViewModel } = await import('../view-models/profile.js');

    const model = mapProfileToViewModel({
      syncStatus: 'failed',
      mode: 'auto-pr',
      failureDetails: {
        reason: 'Source repository inaccessible',
        nextAction: 'Run `openslack collaboration workflow profile-sync check` for details',
      },
    });

    expect(model.syncStatus).toBe('failed');
    expect(model.mode).toBe('auto-pr');
    expect(model.failureDetails).toBeDefined();
    expect(model.failureDetails!.reason).toBe('Source repository inaccessible');
    expect(model.failureDetails!.nextAction).toBe(
      'Run `openslack collaboration workflow profile-sync check` for details',
    );
  });

  it('renders ProfileView with failure panel when sync failed', async () => {
    const tui = await import('@openslack/tui');

    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk: Buffer | string, _encoding: string, cb: () => void) {
        chunks.push(chunk.toString());
        cb();
      },
    }) as NodeJS.WriteStream;

    Object.defineProperties(stdout, {
      columns: { value: 100, writable: true, configurable: true },
      rows: { value: 40, writable: true, configurable: true },
      isTTY: { value: false, configurable: true },
    });

    const model = tui.mapProfileToViewModel({
      syncStatus: 'failed',
      mode: 'manual',
      failureDetails: {
        reason: 'Marker not found in target',
        nextAction: 'Run openslack collaboration workflow profile-sync check',
      },
    });

    const ProfileView = (await import('../views/ProfileView.js')).default;

    instance = await tui.render(React.createElement(ProfileView, { model }), {
      stdout,
      patchConsole: false,
    });

    await new Promise((r) => setTimeout(r, 150));

    const output = chunks.join('');
    expect(output).toContain('Sync Failed');
    expect(output).toContain('Marker not found in target');
    expect(output).toContain('Run openslack collaboration workflow profile-sync check');
    expect(output).toContain('Create failure issue');
  }, 15000);

  it('renders ProfileView with sync details pane and mode header', async () => {
    const tui = await import('@openslack/tui');

    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk: Buffer | string, _encoding: string, cb: () => void) {
        chunks.push(chunk.toString());
        cb();
      },
    }) as NodeJS.WriteStream;

    Object.defineProperties(stdout, {
      columns: { value: 100, writable: true, configurable: true },
      rows: { value: 40, writable: true, configurable: true },
      isTTY: { value: false, configurable: true },
    });

    const model = tui.mapProfileToViewModel({
      syncStatus: 'synced',
      mode: 'watch',
      syncDetails: {
        sourceCommit: 'abc1234',
        sourceDate: '2026-05-28T14:00:00Z',
        targetHash: 'sha-target',
        pendingPR: { number: 55, status: 'open' },
        lastSync: { timestamp: '2026-05-28', result: 'success' },
        mode: 'watch',
      },
    });

    const ProfileView = (await import('../views/ProfileView.js')).default;

    instance = await tui.render(React.createElement(ProfileView, { model }), {
      stdout,
      patchConsole: false,
    });

    await new Promise((r) => setTimeout(r, 150));

    const output = chunks.join('');
    // Mode in header
    expect(output).toContain('Mode: watch');
    // Sync Details pane
    expect(output).toContain('Sync Details');
    expect(output).toContain('abc1234');
    expect(output).toContain('sha-target');
    expect(output).toContain('#55');
    expect(output).toContain('2026-05-28');
  }, 15000);

  it('sanitizes profile action result and check groups', async () => {
    const { mapProfileToViewModel } = await import('../view-models/profile.js');

    const model = mapProfileToViewModel({
      actionResult: {
        actionId: 'check',
        success: false,
        message: 'Check failed \x1b]0;bad-title\x07',
      },
      checkGroups: [
        {
          key: 'source',
          label: '\x1b]52;c;payload\x07Source repository',
          status: 'warn',
          detail: '\x1b]8;;https://bad.example\x07click\x1b]8;;\x07 detail',
        },
      ],
    });

    expect(model.actionResult?.message).toBe('Check failed ');
    expect(model.checkGroups?.[0]?.label).toBe('Source repository');
    expect(model.checkGroups?.[0]?.detail).toBe('click detail');
  });

  it('defaults profile mode to manual when not specified', async () => {
    const { mapProfileToViewModel } = await import('../view-models/profile.js');

    const model = mapProfileToViewModel({});
    expect(model.mode).toBe('manual');
    expect(model.syncDetails).toBeUndefined();
    expect(model.failureDetails).toBeUndefined();
  });
});
