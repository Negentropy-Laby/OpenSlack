import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRunStore, buildPermissionProfile, inspectRunRepair } from '@openslack/agent-runtime';
import { agentRuntimeCommands } from '../commands/agent-runtime.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openslack-repair-cli-')); roots.push(root);
  writeFileSync(join(root, 'openslack.yaml'), '# synthetic fixture only\n');
  const runId = 'RUN-CLI-REPAIR', config = { agentId: 'fixture', source: 'unit-test' };
  createRunStore(root, { sweepOrphans: false }).createRun({ runId, agentId: 'fixture', prompt: 'not sent', resolvedConfig: config,
    permissionProfile: buildPermissionProfile(config) });
  const directory = join(root, '.openslack.local/agents/runs', runId);
  const snapshot = () => readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name)).toString('base64')]);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const out = vi.spyOn(console, 'log').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { root, runId, snapshot, out, error };
}
describe('single-run repair CLI is preview-only without a scoped host authority', () => {
  it('reads exact inspection JSON without sweep, archive or byte changes', async () => {
    const value = fixture(), bytes = value.snapshot();
    const inspection = inspectRunRepair(value.root, value.runId);
    await agentRuntimeCommands().parseAsync(['node', 'test', 'repair-run', value.runId, '--format', 'json']);
    expect(JSON.parse(String(value.out.mock.calls[0]![0]))).toEqual(inspection);
    expect(value.snapshot()).toEqual(bytes); expect(value.error).not.toHaveBeenCalled();
  });
  it.each(['stock', 'forged'] as const)('cannot turn --write and the correct digest into %s maintenance authority', async mode => {
    const value = fixture(), bytes = value.snapshot(), inspection = inspectRunRepair(value.root, value.runId);
    await agentRuntimeCommands(mode === 'stock' ? {} : { runRepairAuthority: {} as never }).parseAsync(
      ['node', 'test', 'repair-run', value.runId, '--write', '--inspection-sha256', inspection.inspectionSha256]);
    expect(value.error).toHaveBeenCalledExactlyOnceWith('RUN_REPAIR_NOT_AUTHORIZED');
    expect(value.out).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1);
    expect(value.snapshot()).toEqual(bytes);
  });
});
