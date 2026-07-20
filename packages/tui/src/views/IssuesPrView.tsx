import React, { useState, useCallback } from 'react';
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
import useInput from '../ink/hooks/use-input.js';
import Pane from '../design-system/Pane.js';
import ThemedText from '../design-system/ThemedText.js';
import Divider from '../design-system/Divider.js';
import StatusIcon from '../design-system/StatusIcon.js';
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js';
import { useNavigation } from '../navigation/context.js';
import { useClampedIndex } from '../hooks/use-clamped-index.js';
import type { IssuesPrViewModel } from '../view-models/issues-pr.js';

type Tab = 'issues' | 'prs';

type IssuesPrViewProps = {
  model: IssuesPrViewModel;
  onSelectIssue?: (issueNumber: number) => void;
  onSelectPr?: (prNumber: number) => void;
};

const STATUS_ICONS: Record<string, 'pass' | 'warn' | 'fail' | 'info' | 'blocked'> = {
  ready: 'pass',
  claimed: 'info',
  running: 'info',
  blocked: 'blocked',
  review: 'warn',
  stale: 'fail',
  pending: 'warn',
  checking: 'info',
};

function formatIssueDetail(status: string, assignee: string | undefined, labels: string[]): string {
  let result = status;
  if (assignee) result += ' - ' + assignee;
  if (labels.length > 0) result += ' [' + labels.join(', ') + ']';
  return result;
}

function formatPrDetail(
  status: string,
  author: string,
  riskZone: string,
  blocker: string | undefined,
): string {
  let result = status + ' - ' + author + ' - ' + riskZone;
  if (blocker) result += ' - blocked: ' + blocker;
  return result;
}

export default function IssuesPrView({
  model,
  onSelectIssue,
  onSelectPr,
}: IssuesPrViewProps): React.JSX.Element {
  const { pop, push } = useNavigation();
  const [tab, setTab] = useState<Tab>(model.tab);

  const issues = model.issues;
  const prs = model.prs;
  const currentItems = tab === 'issues' ? issues : prs;
  const itemCount = currentItems.length;
  const [selectedIndex, setSelectedIndex] = useClampedIndex(itemCount);

  const handleSelect = useCallback(() => {
    if (tab === 'issues') {
      const issue = issues[selectedIndex];
      if (issue) {
        if (onSelectIssue) {
          onSelectIssue(issue.number);
        } else {
          push({ view: 'room', params: { roomId: `issue:${issue.number}` } });
        }
      }
    } else {
      const pr = prs[selectedIndex];
      if (pr) {
        if (onSelectPr) {
          onSelectPr(pr.number);
        } else {
          push({ view: 'room', params: { roomId: `pr:${pr.number}` } });
        }
      }
    }
  }, [tab, selectedIndex, issues, prs, onSelectIssue, onSelectPr, push]);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      pop();
      return;
    }
    if (input === '1') {
      setTab('issues');
      setSelectedIndex(0);
      return;
    }
    if (input === '2') {
      setTab('prs');
      setSelectedIndex(0);
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : itemCount - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => (prev < itemCount - 1 ? prev + 1 : 0));
    } else if (key.return) {
      handleSelect();
    }
  });

  const tabIndicator = (t: Tab, label: string, num: number) => {
    const isActive = tab === t;
    const text = isActive ? '[' + label + ' (' + num + ')]' : ' ' + label + ' (' + num + ') ';
    return React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(
        ThemedText,
        { colorTheme: isActive ? 'accent' : 'muted', bold: isActive },
        text,
      ),
    );
  };

  const issueRows = issues.map((issue, i) => {
    const isSelected = i === selectedIndex;
    const pointer = isSelected ? '>' : ' ';
    const statusIcon = STATUS_ICONS[issue.status] ?? 'info';
    const title = '#' + issue.number + ' ' + issue.title;

    return React.createElement(
      Box,
      { key: 'issue-' + issue.number, flexDirection: 'column' },
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(ThemedText, { colorTheme: isSelected ? 'accent' : 'muted' }, pointer),
        React.createElement(Text, null, ' '),
        React.createElement(StatusIcon, { status: statusIcon }),
        React.createElement(Text, null, ' '),
        React.createElement(
          ThemedText,
          { colorTheme: isSelected ? 'accent' : 'foreground', bold: isSelected },
          title,
        ),
      ),
      React.createElement(
        Box,
        { marginLeft: 3 },
        React.createElement(
          ThemedText,
          { colorTheme: 'muted', dim: true },
          formatIssueDetail(issue.status, issue.assignee, issue.labels),
        ),
      ),
    );
  });

  const prRows = prs.map((pr, i) => {
    const isSelected = i === selectedIndex;
    const pointer = isSelected ? '>' : ' ';
    const statusIcon = STATUS_ICONS[pr.status] ?? 'info';
    const title = 'PR #' + pr.number + ' ' + pr.title;

    return React.createElement(
      Box,
      { key: 'pr-' + pr.number, flexDirection: 'column' },
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(ThemedText, { colorTheme: isSelected ? 'accent' : 'muted' }, pointer),
        React.createElement(Text, null, ' '),
        React.createElement(StatusIcon, { status: statusIcon }),
        React.createElement(Text, null, ' '),
        React.createElement(
          ThemedText,
          { colorTheme: isSelected ? 'accent' : 'foreground', bold: isSelected },
          title,
        ),
      ),
      React.createElement(
        Box,
        { marginLeft: 3 },
        React.createElement(
          ThemedText,
          { colorTheme: 'muted', dim: true },
          formatPrDetail(pr.status, pr.author, pr.riskZone, pr.blocker),
        ),
      ),
    );
  });

  const summaryText =
    tab === 'issues'
      ? 'Issues: ' +
        model.summary.issues.total +
        ' (' +
        model.summary.issues.ready +
        ' ready, ' +
        model.summary.issues.claimed +
        ' claimed, ' +
        model.summary.issues.blocked +
        ' blocked)'
      : 'PRs: ' +
        model.summary.prs.total +
        ' (' +
        model.summary.prs.ready +
        ' ready, ' +
        model.summary.prs.blocked +
        ' blocked, ' +
        model.summary.prs.pending +
        ' pending)';

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(
        ThemedText,
        { colorTheme: 'accent', bold: true },
        'OpenSlack / Tasks & PRs',
      ),
      React.createElement(Text, null, '  '),
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, summaryText),
    ),
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      tabIndicator('issues', 'Issues', issues.length),
      React.createElement(Text, null, '  '),
      tabIndicator('prs', 'PRs', prs.length),
    ),
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Pane,
      { title: tab === 'issues' ? 'Issues' : 'Pull Requests', marginY: 0 },
      React.createElement(
        Box,
        { flexDirection: 'column' },
        ...(tab === 'issues' ? issueRows : prRows),
      ),
    ),
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['1'], description: 'issues' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['2'], description: 'PRs' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Up/Down'], description: 'navigate' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Enter'], description: 'open room' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
    ),
  );
}
