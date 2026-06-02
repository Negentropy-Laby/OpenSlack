export interface AgentParticipant {
  id: string;
  kind: 'human' | 'agent' | 'subagent' | 'system';
  provider?: 'openslack' | 'claude-code' | 'codex' | 'github' | 'slack';
  displayName: string;
  role?: 'operator' | 'reviewer' | 'implementer' | 'researcher' | 'planner';
  permissions?: string[];
  model?: string;
  color?: string;
}

export type ConversationStatus = 'open' | 'active' | 'paused' | 'completed' | 'archived';
export type MemoryPolicy = 'local' | 'project' | 'none';

export interface ConversationLinkedObject {
  kind: 'issue' | 'pr' | 'workflow_run' | 'handoff' | 'decision' | 'room';
  id: string;
  url?: string;
}

import type { NextAction } from './types.js';

export interface AgentConversationThread {
  id: string;
  schema: 'openslack.agent_conversation_thread.v1';
  title: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  participants: AgentParticipant[];
  linkedObjects: ConversationLinkedObject[];
  memoryPolicy: MemoryPolicy;
  summary?: string;
  nextAction?: NextAction;
}

export type AgentConversationMessage =
  | {
      kind: 'user_message';
      id: string;
      threadId: string;
      timestamp: string;
      authorId: string;
      text: string;
      source?: { kind: string; ref: string };
    }
  | {
      kind: 'agent_response';
      id: string;
      threadId: string;
      timestamp: string;
      authorId: string;
      text: string;
      structured?: unknown;
    }
  | {
      kind: 'tool_event';
      id: string;
      threadId: string;
      timestamp: string;
      authorId: string;
      toolName: string;
      input?: unknown;
      output?: unknown;
    }
  | {
      kind: 'plan';
      id: string;
      threadId: string;
      timestamp: string;
      authorId: string;
      planId: string;
      steps: string[];
    }
  | {
      kind: 'approval_request';
      id: string;
      threadId: string;
      timestamp: string;
      authorId: string;
      targetAction: string;
      riskLevel: string;
    }
  | {
      kind: 'decision';
      id: string;
      threadId: string;
      timestamp: string;
      authorId: string;
      decisionId: string;
      summary: string;
    }
  | {
      kind: 'handoff';
      id: string;
      threadId: string;
      timestamp: string;
      authorId: string;
      handoffId: string;
      toParticipant: string;
      summary: string;
    }
  | {
      kind: 'agent_run_event';
      id: string;
      threadId: string;
      timestamp: string;
      authorId: string;
      runId: string;
      eventType: string;
      summary: string;
    };

export type AgentConversationMessageKind = AgentConversationMessage['kind'];

export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type NewConversationMessage = DistributiveOmit<AgentConversationMessage, 'id' | 'timestamp'>;

export function isAgentConversationMessage(value: unknown): value is AgentConversationMessage {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.kind !== 'string') return false;
  const validKinds: string[] = [
    'user_message',
    'agent_response',
    'tool_event',
    'plan',
    'approval_request',
    'decision',
    'handoff',
    'agent_run_event',
  ];
  return validKinds.includes(obj.kind);
}
