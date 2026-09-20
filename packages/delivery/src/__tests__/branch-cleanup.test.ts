import { describe, expect, it, vi } from 'vitest';
import { deleteRemoteBranchIfAt, readRemoteBranchSha } from '../branch-cleanup.js';
import type { BranchCleanupDependencies } from '../branch-cleanup.js';

const input = {
  rootDir: '.',
  owner: 'acme',
  repo: 'repo',
  branch: 'topic',
  expectedSha: 'a'.repeat(40),
};
function dependencies(): BranchCleanupDependencies {
  return {
    tokenProvider: {
      acquire: vi
        .fn()
        .mockResolvedValue({ value: 'test-token', permissions: { contents: 'write' } }),
      invalidate: vi.fn(),
    },
    repositoryInspector: vi.fn().mockResolvedValue({ accessible: true, complete: true }),
    gitPublisher: {
      readRemoteBranchSha: vi.fn().mockReturnValue(input.expectedSha),
      deleteRemoteRefIfAt: vi
        .fn()
        .mockReturnValue({ state: 'DELETED', attempted: true, observedRefState: 'ABSENT' }),
    },
  };
}
describe('branch cleanup App boundary', () => {
  it.each(['read', 'delete'])(
    'owns %s input before token acquisition awaits',
    async (operation) => {
      const deps = dependencies();
      let release!: () => void;
      vi.mocked(deps.tokenProvider!.acquire).mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          value: 'test-token',
          permissions: { contents: 'write' },
          installationId: '1',
          expiresAt: '2100-01-01',
        };
      });
      const mutable = { ...input };
      const transport = deps.gitPublisher!;
      const pending =
        operation === 'read'
          ? readRemoteBranchSha(mutable, deps)
          : deleteRemoteBranchIfAt(mutable, deps);
      mutable.owner = 'attacker';
      mutable.repo = 'other';
      mutable.branch = 'other';
      mutable.expectedSha = 'b'.repeat(40);
      deps.gitPublisher = { readRemoteBranchSha: vi.fn(), deleteRemoteRefIfAt: vi.fn() };
      release();
      await pending;
      expect(
        operation === 'read' ? transport.readRemoteBranchSha : transport.deleteRemoteRefIfAt,
      ).toHaveBeenCalledWith(
        expect.objectContaining(
          operation === 'read' ? { owner: 'acme', repo: 'repo', branch: 'topic' } : input,
        ),
      );
      expect(deps.gitPublisher.deleteRemoteRefIfAt).not.toHaveBeenCalled();
    },
  );
  it('passes the exact lease and only contents capability is required', async () => {
    const deps = dependencies();
    expect(await readRemoteBranchSha(input, deps)).toBe(input.expectedSha);
    expect((await deleteRemoteBranchIfAt(input, deps)).state).toBe('DELETED');
    expect(deps.gitPublisher?.deleteRemoteRefIfAt).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSha: input.expectedSha,
        token: 'test-token',
        remote: 'origin',
      }),
    );
  });
  it('fails closed on unavailable token without a transport call', async () => {
    const deps = dependencies();
    vi.mocked(deps.tokenProvider!.acquire).mockRejectedValue(new Error('secret'));
    await expect(deleteRemoteBranchIfAt(input, deps)).rejects.toMatchObject({
      code: 'DELIVERY_AUTH_REQUIRED',
    });
    expect(deps.gitPublisher?.deleteRemoteRefIfAt).not.toHaveBeenCalled();
  });
  it.each([
    [
      'contents permission',
      { contents: 'read' },
      { accessible: true, complete: true },
      'DELIVERY_PERMISSION_DENIED',
    ],
    [
      'repository',
      { contents: 'write' },
      { accessible: false, complete: true },
      'DELIVERY_REPOSITORY_NOT_INSTALLED',
    ],
    [
      'incomplete evidence',
      { contents: 'write' },
      { accessible: true, complete: false },
      'DELIVERY_REPOSITORY_SCOPE_INCOMPLETE',
    ],
  ] as const)('rejects %s', async (_, permissions, access, code) => {
    const deps = dependencies();
    vi.mocked(deps.tokenProvider!.acquire).mockResolvedValue({
      value: 'test-token',
      permissions,
      installationId: '1',
      expiresAt: '2100-01-01',
    });
    vi.mocked(deps.repositoryInspector!).mockResolvedValue(access as never);
    await expect(deleteRemoteBranchIfAt(input, deps)).rejects.toMatchObject({ code });
    expect(deps.gitPublisher?.deleteRemoteRefIfAt).not.toHaveBeenCalled();
  });
  it.each([
    'openslack/claims',
    'openslack/claims/issue-1',
    'openslack/probes',
    'openslack/probes/write-123',
  ])('rejects reserved %s before authentication', async (branch) => {
    const deps = dependencies();
    await expect(deleteRemoteBranchIfAt({ ...input, branch }, deps)).rejects.toThrow('reserved');
    expect(deps.tokenProvider?.acquire).not.toHaveBeenCalled();
  });
  it('bounds token acquisition by the shared deadline', async () => {
    const deps = dependencies();
    vi.mocked(deps.tokenProvider!.acquire).mockReturnValue(new Promise(() => {}));
    await expect(deleteRemoteBranchIfAt({ ...input, timeoutMs: 10 }, deps)).rejects.toMatchObject({
      code: 'DELIVERY_TIMEOUT',
    });
    expect(deps.gitPublisher?.deleteRemoteRefIfAt).not.toHaveBeenCalled();
  });
  it('does not retry an uncertain deletion or refresh credentials', async () => {
    const deps = dependencies();
    vi.mocked(deps.gitPublisher!.deleteRemoteRefIfAt).mockReturnValue({
      state: 'ABSENT_AFTER_ATTEMPT',
      attempted: true,
      observedRefState: 'ABSENT',
    });
    expect((await deleteRemoteBranchIfAt(input, deps)).state).toBe('ABSENT_AFTER_ATTEMPT');
    expect(deps.gitPublisher?.deleteRemoteRefIfAt).toHaveBeenCalledTimes(1);
    expect(deps.tokenProvider?.invalidate).not.toHaveBeenCalled();
  });
});
