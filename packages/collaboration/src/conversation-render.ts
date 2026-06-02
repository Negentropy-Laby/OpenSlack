import type { AgentConversationThread, AgentConversationMessage } from './conversation-types.js';

export function renderThreadList(threads: AgentConversationThread[]): string {
  if (threads.length === 0) {
    return 'No conversations found.';
  }

  const lines: string[] = [];
  lines.push('Conversations');
  lines.push('═════════════');
  lines.push('');

  for (const t of threads) {
    const statusIcon =
      t.status === 'open' ? '○' :
      t.status === 'active' ? '●' :
      t.status === 'paused' ? '◐' :
      t.status === 'completed' ? '◉' :
      t.status === 'archived' ? '▢' :
      '◇';

    const participantCount = t.participants.length;
    const linkedInfo = t.linkedObjects.map((o) => `${o.kind}:${o.id}`).join(', ');
    const suffix = linkedInfo ? `  [${linkedInfo}]` : '';

    lines.push(`${statusIcon} ${t.id}  ${t.title.slice(0, 50)}${t.title.length > 50 ? '...' : ''}`);
    lines.push(`   Status: ${t.status}  Participants: ${participantCount}${suffix}`);

    if (t.summary) {
      lines.push(`   ${t.summary.slice(0, 80)}${t.summary.length > 80 ? '...' : ''}`);
    }

    if (t.nextAction) {
      lines.push(`   Next: ${t.nextAction.owner} — ${t.nextAction.action}`);
    }
  }

  return lines.join('\n');
}

export function renderThread(thread: AgentConversationThread, messages: AgentConversationMessage[]): string {
  const lines: string[] = [];

  lines.push(`Conversation: ${thread.id}`);
  lines.push('─'.repeat(60));
  lines.push(`Title:     ${thread.title}`);
  lines.push(`Status:    ${thread.status}`);
  lines.push(`Memory:    ${thread.memoryPolicy}`);
  lines.push(`Created:   ${thread.createdAt}`);
  lines.push(`Updated:   ${thread.updatedAt}`);

  if (thread.participants.length > 0) {
    lines.push('');
    lines.push('Participants:');
    for (const p of thread.participants) {
      const roleStr = p.role ? ` (${p.role})` : '';
      const providerStr = p.provider ? ` [${p.provider}]` : '';
      lines.push(`  • ${p.displayName}${roleStr}${providerStr} (${p.kind})`);
    }
  }

  if (thread.linkedObjects.length > 0) {
    lines.push('');
    lines.push('Linked Objects:');
    for (const obj of thread.linkedObjects) {
      const urlStr = obj.url ? ` — ${obj.url}` : '';
      lines.push(`  • ${obj.kind}:${obj.id}${urlStr}`);
    }
  }

  if (thread.summary) {
    lines.push('');
    lines.push('Summary:');
    lines.push(thread.summary);
  }

  if (thread.nextAction) {
    lines.push('');
    lines.push(`Next Action: ${thread.nextAction.owner} — ${thread.nextAction.action}`);
    if (thread.nextAction.command) {
      lines.push(`  Command: ${thread.nextAction.command}`);
    }
  }

  if (messages.length > 0) {
    lines.push('');
    lines.push(`Messages (${messages.length})`);
    lines.push('─'.repeat(40));
    for (const msg of messages) {
      lines.push(renderMessage(msg));
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function renderMessage(message: AgentConversationMessage): string {
  const ts = message.timestamp.replace('T', ' ').slice(0, 19);

  switch (message.kind) {
    case 'user_message': {
      const src = message.source ? ` via ${message.source.kind}` : '';
      return `[${ts}] ${message.authorId}${src}: ${message.text}`;
    }
    case 'agent_response': {
      const structTag = message.structured ? ' (structured)' : '';
      return `[${ts}] ${message.authorId}${structTag}: ${message.text}`;
    }
    case 'tool_event': {
      const hasOutput = message.output !== undefined ? ' => output' : '';
      return `[${ts}] ${message.authorId} tool:${message.toolName}${hasOutput}`;
    }
    case 'plan': {
      const stepList = message.steps.map((s, i) => `    ${i + 1}. ${s}`).join('\n');
      return `[${ts}] ${message.authorId} plan:${message.planId}\n${stepList}`;
    }
    case 'approval_request': {
      return `[${ts}] ${message.authorId} approval_needed: ${message.targetAction} [${message.riskLevel}]`;
    }
    case 'decision': {
      return `[${ts}] ${message.authorId} decision:${message.decisionId} — ${message.summary}`;
    }
    case 'handoff': {
      return `[${ts}] ${message.authorId} handoff:${message.handoffId} → ${message.toParticipant} — ${message.summary}`;
    }
    default: {
      return `[${ts}] unknown message kind`;
    }
  }
}
