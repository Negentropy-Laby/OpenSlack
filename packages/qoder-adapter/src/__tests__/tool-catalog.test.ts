import { describe, expect, it } from 'vitest';
import {
  OPENSLACK_READ_TOOL_CATALOG,
  OPENSLACK_READ_TOOL_NAMES,
  ToolInputValidationError,
  getOpenSlackReadToolDefinition,
  validateToolInput,
} from '../index.js';

describe('Qoder read-tool catalog', () => {
  it('is deeply frozen and contains exactly the nine business tools', () => {
    expect(OPENSLACK_READ_TOOL_CATALOG.map((tool) => tool.name)).toEqual([
      'openslack_get_executive_overview',
      'openslack_list_work_items',
      'openslack_get_work_room',
      'openslack_get_activity',
      'openslack_get_workflow_progress',
      'openslack_get_pr_readiness',
      'openslack_list_pending_approvals',
      'openslack_get_business_outcomes',
      'openslack_get_notification_status',
    ]);
    expect(OPENSLACK_READ_TOOL_NAMES).toHaveLength(9);
    expect(Object.isFrozen(OPENSLACK_READ_TOOL_CATALOG)).toBe(true);
    for (const tool of OPENSLACK_READ_TOOL_CATALOG) {
      expect(Object.isFrozen(tool)).toBe(true);
      expect(Object.isFrozen(tool.inputSchema)).toBe(true);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
  });

  it('contains no generic, shell, mutation, approval, or merge capability', () => {
    const names = OPENSLACK_READ_TOOL_CATALOG.map((tool) => tool.name);
    const forbidden = [
      'run_shell',
      'run_arbitrary_command',
      'github.approve',
      'pr.approve',
      'approve_github_pr',
      'direct_merge',
      'write_policy',
      'change_agent_permissions',
    ];
    expect(names).not.toEqual(expect.arrayContaining(forbidden));
    expect(names).not.toEqual(expect.arrayContaining(['pr.watch', 'workspace.index']));
    expect(names.every((name) => !/shell|raw_command|direct_merge/i.test(name))).toBe(true);
  });

  it('rejects unknown and out-of-bound arguments', () => {
    const tool = getOpenSlackReadToolDefinition('openslack_get_activity');
    expect(tool).toBeDefined();
    expect(() => validateToolInput(tool!, { limit: 101 })).toThrow(ToolInputValidationError);
    expect(() => validateToolInput(tool!, { rawCommand: 'status' })).toThrow(
      /rawCommand is not allowed/,
    );
  });

  it('requires and validates bounded identifiers', () => {
    const room = getOpenSlackReadToolDefinition('openslack_get_work_room')!;
    expect(() => validateToolInput(room, {})).toThrow(/roomId is required/);
    expect(() => validateToolInput(room, { roomId: '../../secret' })).toThrow(/invalid format/);
    expect(validateToolInput(room, { roomId: 'pr:312', limit: 20 })).toEqual({
      roomId: 'pr:312',
      limit: 20,
    });
  });
});
