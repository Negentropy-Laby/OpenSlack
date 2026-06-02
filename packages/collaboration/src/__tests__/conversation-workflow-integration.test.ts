import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createThread,
  listThreads,
  getThread,
  appendMessage,
  recordEvent,
  readEvents,
  filterEvents,
  buildRoomView,
} from '../index.js';
import type {
  AgentConversationMessage,
  CollaborationEvent,
} from '../index.js';

/**
 * Integration tests for conversation-workflow interaction.
 *
 * These tests verify that the conversation store and the collaboration event
 * system work together correctly when simulating an agent-workflow lifecycle:
 *   thread creation -> workflow agent call -> events emitted -> thread queryable
 */
describe('conversation-workflow integration', () => {
  let origCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-conv-wf-integ-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: simulate a workflow agent call on a conversation thread.
   * This creates the conversation.started and conversation.completed events
   * that the collaboration event system expects during real agent lifecycles.
   */
  function simulateWorkflowAgentCall(
    threadId: string,
    agentId: string,
    correlationId: string,
  ): { startedEvent: CollaborationEvent; completedEvent: CollaborationEvent } {
    const startedEvent = recordEvent({
      type: 'agent.conversation.started',
      actor: { id: agentId, kind: 'agent' },
      object: { kind: 'agent', id: threadId },
      source: { kind: 'openslack', ref: threadId },
      summary: `Agent ${agentId} started conversation ${threadId}`,
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      correlationId,
    });

    const completedEvent = recordEvent({
      type: 'agent.conversation.completed',
      actor: { id: agentId, kind: 'agent' },
      object: { kind: 'agent', id: threadId },
      source: { kind: 'openslack', ref: threadId },
      summary: `Agent ${agentId} completed conversation ${threadId}`,
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      correlationId,
    });

    return { startedEvent, completedEvent };
  }

  // ---------------------------------------------------------------
  // Test 1: End-to-end lifecycle — create thread, simulate agent
  // workflow call, verify events emitted, verify thread queryable.
  // ---------------------------------------------------------------
  it('end-to-end: creates thread, simulates workflow agent call, emits started/completed events, thread is queryable', () => {
    const correlationId = 'corr-e2e-001';

    // Step 1: Create a conversation thread with participants
    const thread = createThread({
      title: 'E2E Workflow Conversation',
      participants: [
        { id: 'human-1', kind: 'human', displayName: 'Alice', role: 'operator' },
        { id: 'agent-claude', kind: 'agent', displayName: 'Claude', role: 'implementer', provider: 'openslack' },
      ],
      linkedObjects: [{ kind: 'issue', id: '42' }],
    });

    expect(thread.id).toMatch(/^CONV-/);
    expect(thread.status).toBe('open');
    expect(thread.participants).toHaveLength(2);

    // Step 2: Append a user message to the thread
    const userMsg = appendMessage(thread.id, {
      kind: 'user_message',
      threadId: thread.id,
      authorId: 'human-1',
      text: 'Please implement the AC-6 integration tests.',
    });
    expect(userMsg.id).toMatch(/^MSG-/);

    // Step 3: Simulate the workflow agent call — this emits conversation events
    const { startedEvent, completedEvent } = simulateWorkflowAgentCall(
      thread.id,
      'agent-claude',
      correlationId,
    );

    // Step 4: Verify agent.conversation.started event was emitted
    expect(startedEvent.type).toBe('agent.conversation.started');
    expect(startedEvent.actor.id).toBe('agent-claude');
    expect(startedEvent.correlationId).toBe(correlationId);
    expect(startedEvent.schema).toBe('openslack.collaboration_event.v1');

    // Step 5: Verify agent.conversation.completed event was emitted
    expect(completedEvent.type).toBe('agent.conversation.completed');
    expect(completedEvent.actor.id).toBe('agent-claude');
    expect(completedEvent.correlationId).toBe(correlationId);

    // Step 6: Append agent response message
    const agentMsg = appendMessage(thread.id, {
      kind: 'agent_response',
      threadId: thread.id,
      authorId: 'agent-claude',
      text: 'I have created the integration tests. All 5 tests are passing.',
    });
    expect(agentMsg.id).toMatch(/^MSG-/);

    // Step 7: Verify the thread is queryable with all messages
    const result = getThread(thread.id);
    expect(result).not.toBeNull();
    expect(result!.thread.id).toBe(thread.id);
    expect(result!.thread.status).toBe('active');
    expect(result!.messages).toHaveLength(2);

    // Verify message ordering
    const kinds = result!.messages.map((m: AgentConversationMessage) => m.kind);
    expect(kinds).toEqual(['user_message', 'agent_response']);
  });

  // ---------------------------------------------------------------
  // Test 2: Error path — agent call fails, verify
  // conversation.failed event emitted.
  // ---------------------------------------------------------------
  it('error path: agent call fails, emits conversation.failed event', () => {
    const correlationId = 'corr-err-002';

    // Create thread
    const thread = createThread({
      title: 'Failing Workflow Conversation',
      participants: [
        { id: 'human-1', kind: 'human', displayName: 'Bob' },
        { id: 'agent-codex', kind: 'agent', displayName: 'Codex', provider: 'openslack' },
      ],
    });

    // User sends a message
    appendMessage(thread.id, {
      kind: 'user_message',
      threadId: thread.id,
      authorId: 'human-1',
      text: 'Please fix the broken build.',
    });

    // Emit conversation.started
    const startedEvent = recordEvent({
      type: 'agent.conversation.started',
      actor: { id: 'agent-codex', kind: 'agent' },
      object: { kind: 'agent', id: thread.id },
      source: { kind: 'openslack', ref: thread.id },
      summary: `Agent agent-codex started conversation ${thread.id}`,
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      correlationId,
    });
    expect(startedEvent.type).toBe('agent.conversation.started');

    // Simulate failure — emit conversation.failed
    const failedEvent = recordEvent({
      type: 'agent.conversation.failed',
      actor: { id: 'agent-codex', kind: 'agent' },
      object: { kind: 'agent', id: thread.id },
      source: { kind: 'openslack', ref: thread.id },
      summary: `Agent agent-codex failed in conversation ${thread.id}: workspace validation error`,
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      correlationId,
      severity: 'critical',
    });

    // Verify the failed event
    expect(failedEvent.type).toBe('agent.conversation.failed');
    expect(failedEvent.actor.id).toBe('agent-codex');
    expect(failedEvent.severity).toBe('critical');
    expect(failedEvent.correlationId).toBe(correlationId);
    expect(failedEvent.summary).toContain('failed');

    // Verify the failed event can be read back from the event log
    const allEvents = readEvents();
    const convEvents = allEvents.filter(
      (e) => e.correlationId === correlationId,
    );
    expect(convEvents).toHaveLength(2);
    expect(convEvents[0].type).toBe('agent.conversation.started');
    expect(convEvents[1].type).toBe('agent.conversation.failed');

    // Verify the thread still exists and is queryable (thread state is independent)
    const result = getThread(thread.id);
    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(1);
  });

  // ---------------------------------------------------------------
  // Test 3: Activity feed — verify conversation events appear in
  // the collaboration activity feed when filtered.
  // ---------------------------------------------------------------
  it('activity feed: conversation events appear in collaboration activity feed', () => {
    // Create two threads with independent lifecycles
    const thread1 = createThread({ title: 'Feed Test Alpha' });
    const thread2 = createThread({ title: 'Feed Test Beta' });

    appendMessage(thread1.id, {
      kind: 'user_message',
      threadId: thread1.id,
      authorId: 'human-1',
      text: 'Start task A',
    });

    appendMessage(thread2.id, {
      kind: 'user_message',
      threadId: thread2.id,
      authorId: 'human-1',
      text: 'Start task B',
    });

    // Emit events for both threads
    recordEvent({
      type: 'agent.conversation.started',
      actor: { id: 'agent-1', kind: 'agent' },
      object: { kind: 'agent', id: thread1.id },
      source: { kind: 'openslack', ref: thread1.id },
      summary: 'Started thread alpha',
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      correlationId: 'corr-feed-alpha',
    });

    recordEvent({
      type: 'agent.conversation.completed',
      actor: { id: 'agent-1', kind: 'agent' },
      object: { kind: 'agent', id: thread1.id },
      source: { kind: 'openslack', ref: thread1.id },
      summary: 'Completed thread alpha',
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      correlationId: 'corr-feed-alpha',
    });

    recordEvent({
      type: 'agent.conversation.failed',
      actor: { id: 'agent-2', kind: 'agent' },
      object: { kind: 'agent', id: thread2.id },
      source: { kind: 'openslack', ref: thread2.id },
      summary: 'Failed thread beta',
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      correlationId: 'corr-feed-beta',
      severity: 'critical',
    });

    // Verify: all agent.conversation.* events appear in the feed
    const allEvents = readEvents();
    const convEvents = filterEvents(allEvents, {
      type: [
        'agent.conversation.started',
        'agent.conversation.completed',
        'agent.conversation.failed',
      ],
    });

    expect(convEvents).toHaveLength(3);

    // Verify: can filter by specific thread
    const thread1Events = filterEvents(allEvents, {
      objectId: thread1.id,
    });
    expect(thread1Events).toHaveLength(2);
    expect(thread1Events[0].type).toBe('agent.conversation.started');
    expect(thread1Events[1].type).toBe('agent.conversation.completed');

    // Verify: can filter by specific event type
    const failedEvents = filterEvents(allEvents, {
      type: 'agent.conversation.failed',
    });
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].summary).toContain('Failed thread beta');

    // Verify: can filter by actor
    const agent2Events = filterEvents(allEvents, {
      actorId: 'agent-2',
    });
    expect(agent2Events).toHaveLength(1);
    expect(agent2Events[0].object.id).toBe(thread2.id);
  });

  // ---------------------------------------------------------------
  // Test 4: Room binding — create thread linked to a room, verify
  // room view includes the thread's events.
  // ---------------------------------------------------------------
  it('room binding: thread linked to room includes thread events in room view', () => {
    // Create a thread linked to an issue room
    const thread = createThread({
      title: 'Room-Linked Conversation',
      participants: [
        { id: 'human-1', kind: 'human', displayName: 'Carol' },
        { id: 'agent-1', kind: 'agent', displayName: 'Assistant' },
      ],
      linkedObjects: [
        { kind: 'issue', id: '99' },
      ],
    });

    appendMessage(thread.id, {
      kind: 'user_message',
      threadId: thread.id,
      authorId: 'human-1',
      text: 'Review the PR for this issue.',
    });

    // Emit conversation events tied to the issue object (so they appear in room)
    recordEvent({
      type: 'agent.conversation.started',
      actor: { id: 'agent-1', kind: 'agent' },
      object: { kind: 'issue', id: '99' },
      source: { kind: 'openslack', ref: thread.id },
      summary: `Agent started conversation for issue 99 (thread ${thread.id})`,
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      correlationId: 'corr-room-99',
    });

    recordEvent({
      type: 'agent.conversation.completed',
      actor: { id: 'agent-1', kind: 'agent' },
      object: { kind: 'issue', id: '99' },
      source: { kind: 'openslack', ref: thread.id },
      summary: `Agent completed conversation for issue 99 (thread ${thread.id})`,
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      correlationId: 'corr-room-99',
    });

    // Build room view for issue:99
    const allEvents = readEvents();
    const roomView = buildRoomView('issue:99', allEvents);

    expect(roomView).not.toBeUndefined();
    expect(roomView!.roomId).toBe('issue:99');
    expect(roomView!.objectKind).toBe('issue');
    expect(roomView!.objectId).toBe('99');

    // Verify room contains the conversation events
    expect(roomView!.recentEvents.length).toBeGreaterThanOrEqual(2);

    const eventTypes = roomView!.recentEvents.map((e) => e.type);
    expect(eventTypes).toContain('agent.conversation.started');
    expect(eventTypes).toContain('agent.conversation.completed');

    // Verify thread is queryable and linked to the issue
    const threadData = getThread(thread.id);
    expect(threadData).not.toBeNull();
    expect(threadData!.thread.linkedObjects).toHaveLength(1);
    expect(threadData!.thread.linkedObjects[0].kind).toBe('issue');
    expect(threadData!.thread.linkedObjects[0].id).toBe('99');
  });

  // ---------------------------------------------------------------
  // Test 5: Multi-message workflow — simulate a full multi-turn
  // agent conversation with plans, tool events, and decisions.
  // ---------------------------------------------------------------
  it('multi-message workflow: full agent conversation with plans, tools, and decisions', () => {
    const correlationId = 'corr-multi-005';

    const thread = createThread({
      title: 'Full Agent Conversation',
      participants: [
        { id: 'human-1', kind: 'human', displayName: 'Dave', role: 'operator' },
        { id: 'agent-1', kind: 'agent', displayName: 'Agent', role: 'implementer' },
      ],
    });

    // Emit conversation.started
    recordEvent({
      type: 'agent.conversation.started',
      actor: { id: 'agent-1', kind: 'agent' },
      object: { kind: 'agent', id: thread.id },
      source: { kind: 'openslack', ref: thread.id },
      summary: 'Agent started full conversation',
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      correlationId,
    });

    // User message
    appendMessage(thread.id, {
      kind: 'user_message',
      threadId: thread.id,
      authorId: 'human-1',
      text: 'Implement the new feature.',
    });

    // Agent presents a plan
    appendMessage(thread.id, {
      kind: 'plan',
      threadId: thread.id,
      authorId: 'agent-1',
      planId: 'PLAN-001',
      steps: [
        'Create integration tests',
        'Create product documentation',
        'Update module registry',
        'Run full validation',
      ],
    });

    // Tool events
    appendMessage(thread.id, {
      kind: 'tool_event',
      threadId: thread.id,
      authorId: 'agent-1',
      toolName: 'readFile',
      input: { path: 'packages/collaboration/src/conversation-store.ts' },
      output: { lines: 228 },
    });

    appendMessage(thread.id, {
      kind: 'tool_event',
      threadId: thread.id,
      authorId: 'agent-1',
      toolName: 'writeFile',
      input: { path: 'packages/collaboration/src/__tests__/conversation-workflow-integration.test.ts' },
    });

    // Approval request
    appendMessage(thread.id, {
      kind: 'approval_request',
      threadId: thread.id,
      authorId: 'agent-1',
      targetAction: 'create-pr',
      riskLevel: 'medium',
    });

    // Decision recorded
    appendMessage(thread.id, {
      kind: 'decision',
      threadId: thread.id,
      authorId: 'agent-1',
      decisionId: 'DEC-001',
      summary: 'Use JSONL format for message persistence',
    });

    // Agent response
    appendMessage(thread.id, {
      kind: 'agent_response',
      threadId: thread.id,
      authorId: 'agent-1',
      text: 'Implementation complete. All tests passing.',
    });

    // Emit conversation.completed
    recordEvent({
      type: 'agent.conversation.completed',
      actor: { id: 'agent-1', kind: 'agent' },
      object: { kind: 'agent', id: thread.id },
      source: { kind: 'openslack', ref: thread.id },
      summary: 'Agent completed full conversation with 7 messages',
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      correlationId,
    });

    // Verify the complete thread
    const result = getThread(thread.id);
    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(7);

    // Verify all message kinds are present
    const kinds = result!.messages.map((m: AgentConversationMessage) => m.kind);
    expect(kinds).toEqual([
      'user_message',
      'plan',
      'tool_event',
      'tool_event',
      'approval_request',
      'decision',
      'agent_response',
    ]);

    // Verify specific message details
    const planMsg = result!.messages[1];
    if (planMsg.kind === 'plan') {
      expect(planMsg.steps).toHaveLength(4);
      expect(planMsg.planId).toBe('PLAN-001');
    }

    const decisionMsg = result!.messages[5];
    if (decisionMsg.kind === 'decision') {
      expect(decisionMsg.decisionId).toBe('DEC-001');
      expect(decisionMsg.summary).toContain('JSONL');
    }

    // Verify event log has both boundary events
    const allEvents = readEvents();
    const convEvents = filterEvents(allEvents, { correlationId });
    expect(convEvents).toHaveLength(2);
    expect(convEvents[0].type).toBe('agent.conversation.started');
    expect(convEvents[1].type).toBe('agent.conversation.completed');

    // Verify the thread is queryable in the thread list
    const threads = listThreads({ status: 'active' });
    expect(threads.some((t) => t.id === thread.id)).toBe(true);
  });
});
