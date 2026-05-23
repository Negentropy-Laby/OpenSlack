import type { PRChatSummary } from '@openslack/pr';

export interface ChatCardField {
  label: string;
  value: string;
}

export interface ChatAction {
  id: string;
  label: string;
  style: 'primary' | 'danger' | 'default';
  action: 'show_doctor' | 'watch_pr' | 'confirm_merge' | 'cancel';
  value: string;
}

export interface ChatCard {
  title: string;
  summary: string;
  fields: ChatCardField[];
  actions: ChatAction[];
}

export function buildPRCard(summary: PRChatSummary): ChatCard {
  const fields: ChatCardField[] = [
    { label: 'Zone', value: summary.zone },
    { label: 'Status', value: summary.canMerge ? 'Ready to merge' : 'Blocked' },
  ];

  if (summary.blocker) {
    fields.push({ label: 'Blocker', value: summary.blocker });
  }

  const actions: ChatAction[] = [];

  if (summary.canMerge) {
    actions.push({
      id: 'merge',
      label: 'Confirm merge',
      style: 'primary',
      action: 'confirm_merge',
      value: String(summary.prNumber),
    });
  } else {
    actions.push({
      id: 'doctor',
      label: 'Show full diagnosis',
      style: 'default',
      action: 'show_doctor',
      value: String(summary.prNumber),
    });
    actions.push({
      id: 'watch',
      label: 'Watch PR',
      style: 'default',
      action: 'watch_pr',
      value: String(summary.prNumber),
    });
  }

  return {
    title: `PR #${summary.prNumber} — ${summary.title}`,
    summary: summary.canMerge
      ? `✅ Ready to merge (${summary.zone} zone)`
      : `🚫 Cannot merge${summary.blocker ? `: ${summary.blocker}` : ''}`,
    fields,
    actions,
  };
}

export function toSlackBlocks(card: ChatCard): unknown[] {
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${card.title}*\n${card.summary}`,
      },
    },
  ];

  if (card.fields.length > 0) {
    const fieldTexts = card.fields
      .map((f) => `*${f.label}:* ${f.value}`)
      .join('  |  ');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: fieldTexts,
      },
    });
  }

  if (card.actions.length > 0) {
    blocks.push({
      type: 'actions',
      elements: card.actions.map((a) => ({
        type: 'button',
        text: {
          type: 'plain_text',
          text: a.label,
        },
        action_id: `${a.action}:${a.value}`,
        style: a.style === 'primary' ? 'primary' : a.style === 'danger' ? 'danger' : undefined,
      })),
    });
  }

  return blocks;
}

export function cardToText(card: ChatCard): string {
  const lines: string[] = [];
  lines.push(`${card.title}`);
  lines.push(card.summary);

  if (card.fields.length > 0) {
    for (const f of card.fields) {
      lines.push(`${f.label}: ${f.value}`);
    }
  }

  return lines.join('\n');
}
