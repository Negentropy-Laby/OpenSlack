import React, { useCallback, useState } from 'react';
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
import useInput from '../ink/hooks/use-input.js';
import Pane from '../design-system/Pane.js';
import ThemedText from '../design-system/ThemedText.js';
import Divider from '../design-system/Divider.js';
import StatusIcon from '../design-system/StatusIcon.js';
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js';
import { useClampedIndex } from '../hooks/use-clamped-index.js';
import { useNavigation } from '../navigation/context.js';
import type {
  WorkflowAgentProgressItem,
  WorkflowPhaseProgressItem,
  WorkflowRunProgressItem,
  WorkflowRunProgressViewModel,
} from '../view-models/workflow-runs.js';
import { deriveWorkflowRunDecisionSummary } from '../view-models/workflow-runs.js';
import type {
  TuiActionHandlers,
  WorkflowRunControlAction,
  WorkflowRunControlTarget,
  WorkflowSaveTarget,
} from './render-shell.js';

type ViewMode = 'runs' | 'phases' | 'agent';

type SaveTargetOption = {
  key: string;
  label: string;
  detail: string;
  target?: WorkflowSaveTarget;
};

const SAVE_TARGET_OPTIONS: SaveTargetOption[] = [
  { key: '1', label: 'Project workflow', detail: '.openslack/workflows', target: 'project' },
  { key: '2', label: 'Claude project', detail: '.claude/workflows', target: 'claude-project' },
  { key: '3', label: 'User workflow', detail: '~/.claude/workflows', target: 'user' },
  { key: '4', label: 'Skill package', detail: 'skills/<name> (CLI only)' },
];

export interface WorkflowRunsViewProps {
  model: WorkflowRunProgressViewModel;
  actionHandlers?: TuiActionHandlers;
  onBack?: () => void;
}

function statusCategory(status: string): 'pass' | 'warn' | 'fail' | 'blocked' | 'info' {
  if (status === 'completed') return 'pass';
  if (status === 'failed' || status === 'cancelled') return 'fail';
  if (status === 'paused' || status === 'paused_waiting_approval') return 'blocked';
  if (status === 'running' || status === 'resuming') return 'info';
  return 'warn';
}

function duration(ms: number | undefined): string {
  if (ms === undefined) return 'not recorded';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function actionLabel(action: WorkflowRunControlAction): string {
  if (action === 'stopRun') return 'stop';
  if (action === 'saveScript') return 'save';
  return action;
}

function budgetLine(run: WorkflowRunProgressItem): string {
  const percent =
    run.budget.tokenBudgetPercent === undefined
      ? 'n/a'
      : `${Math.round(run.budget.tokenBudgetPercent * 100)}%`;
  const cost =
    run.budget.costEstimateUsd === undefined
      ? 'cost unknown'
      : `cost $${run.budget.costEstimateUsd.toFixed(6)}`;
  return `${run.budget.tokensUsed}/${run.budget.tokenBudget ?? 'unlimited'} tokens | ${percent} | ${run.budget.status ?? 'unknown'} | ${cost}`;
}

export default function WorkflowRunsView({
  model,
  actionHandlers,
  onBack,
}: WorkflowRunsViewProps): React.JSX.Element {
  const { pop } = useNavigation();
  const [mode, setMode] = useState<ViewMode>('runs');
  const [message, setMessage] = useState<string | undefined>();
  const [runIndex, setRunIndex] = useClampedIndex(model.runs.length);
  const selectedRun = model.runs[runIndex] as WorkflowRunProgressItem | undefined;
  const [phaseIndex, setPhaseIndex] = useClampedIndex(selectedRun?.phases.length ?? 0);
  const selectedPhase = selectedRun?.phases[phaseIndex] as WorkflowPhaseProgressItem | undefined;
  const [agentIndex, setAgentIndex] = useClampedIndex(selectedPhase?.agents.length ?? 0);
  const selectedAgent = selectedPhase?.agents[agentIndex] as WorkflowAgentProgressItem | undefined;
  const [saveTargetIndex, setSaveTargetIndex] = useClampedIndex(SAVE_TARGET_OPTIONS.length);
  const saveTargetOption = SAVE_TARGET_OPTIONS[saveTargetIndex] ?? SAVE_TARGET_OPTIONS[0]!;
  const decisionSummary = selectedRun ? deriveWorkflowRunDecisionSummary(selectedRun) : undefined;

  const goBack = useCallback(() => {
    if (mode === 'agent') {
      setMode('phases');
      return;
    }
    if (mode === 'phases') {
      setMode('runs');
      return;
    }
    if (onBack) onBack();
    else pop();
  }, [mode, onBack, pop]);

  const applyAction = useCallback(
    async (action: WorkflowRunControlAction) => {
      if (!selectedRun) return;
      const target: WorkflowRunControlTarget | undefined = selectedAgent
        ? {
            runId: selectedRun.runId,
            phase: selectedAgent.phase,
            agentRunId: selectedAgent.agentRunId,
            agentId: selectedAgent.label,
          }
        : undefined;
      if (action === 'saveScript') {
        if (!saveTargetOption.target) {
          setMessage(
            `CLI only. Use: openslack collaboration workflow export-skill ${selectedRun.workflowName} --out skills/${selectedRun.workflowName}`,
          );
          return;
        }
        if (actionHandlers?.saveWorkflowRunScript) {
          const result = await actionHandlers.saveWorkflowRunScript(
            selectedRun.runId,
            saveTargetOption.target,
          );
          setMessage(result.message);
          return;
        }
        setMessage(
          `Use: openslack collaboration workflow save-run ${selectedRun.runId} --to ${saveTargetOption.target}`,
        );
        return;
      }
      if (actionHandlers?.controlWorkflowRun) {
        const result = await actionHandlers.controlWorkflowRun(selectedRun.runId, action, target);
        setMessage(result.message);
        return;
      }
      const agentArg = target?.agentRunId ? ` --agent-run-id ${target.agentRunId}` : '';
      setMessage(
        `Use: openslack collaboration workflow runs control ${selectedRun.runId} --action ${action}${agentArg}`,
      );
    },
    [actionHandlers, saveTargetOption, selectedAgent, selectedRun],
  );

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      goBack();
      return;
    }
    if (mode === 'runs') {
      if (key.upArrow || input === 'k') setRunIndex(runIndex - 1);
      if (key.downArrow || input === 'j') setRunIndex(runIndex + 1);
      if (key.return && selectedRun) setMode('phases');
    } else if (mode === 'phases') {
      if (key.upArrow || input === 'k') setPhaseIndex(phaseIndex - 1);
      if (key.downArrow || input === 'j') setPhaseIndex(phaseIndex + 1);
      if (key.return && selectedPhase?.agents.length) setMode('agent');
    } else if (mode === 'agent') {
      if (key.upArrow || input === 'k') setAgentIndex(agentIndex - 1);
      if (key.downArrow || input === 'j') setAgentIndex(agentIndex + 1);
    }
    if (input === 'p') void applyAction('pause');
    if (input === 'r') void applyAction('resume');
    if (input === 'x') void applyAction('stopRun');
    if (input === 'a') void applyAction('stopAgent');
    if (input === 'R') void applyAction('restartAgent');
    if (input === 's') void applyAction('saveScript');
    if (input === 'S') setSaveTargetIndex(saveTargetIndex + 1);
    if (selectedRun) {
      const saveOptionIndex = SAVE_TARGET_OPTIONS.findIndex((option) => option.key === input);
      if (saveOptionIndex >= 0) setSaveTargetIndex(saveOptionIndex);
    }
  });

  return React.createElement(
    Pane,
    { title: 'Dynamic Workflows / Runs', width: 100 },
    React.createElement(
      Box,
      { flexDirection: 'column', gap: 1 },
      React.createElement(
        ThemedText,
        { colorTheme: 'muted' },
        `Runs ${model.summary.total} | running ${model.summary.running} | paused ${model.summary.paused} | failed ${model.summary.failed} | approvals ${model.summary.pendingApprovals}`,
      ),
      decisionSummary ? React.createElement(DecisionSummary, { summary: decisionSummary }) : null,
      selectedRun
        ? React.createElement(
            ThemedText,
            {
              colorTheme:
                selectedRun.budget.status === 'exceeded'
                  ? 'error'
                  : selectedRun.budget.status === 'warning'
                    ? 'warning'
                    : 'muted',
            },
            `Budget ${budgetLine(selectedRun)} | save target ${saveTargetOption.label}`,
          )
        : null,
      selectedRun?.budget.warnings?.length
        ? React.createElement(
            ThemedText,
            { colorTheme: 'warning' },
            `Budget warning: ${selectedRun.budget.warnings.at(-1)}`,
          )
        : null,
      selectedRun
        ? React.createElement(SaveShareChooser, { selectedKey: saveTargetOption.key })
        : null,
      message ? React.createElement(ThemedText, { colorTheme: 'info' }, message) : null,
      React.createElement(Divider, null),
      mode === 'runs'
        ? React.createElement(
            Box,
            { flexDirection: 'column', gap: 1 },
            React.createElement(RunList, { runs: model.runs, selectedIndex: runIndex }),
            selectedRun
              ? React.createElement(PhaseList, {
                  run: selectedRun,
                  phases: selectedRun.phases,
                  selectedIndex: phaseIndex,
                })
              : null,
          )
        : mode === 'phases' && selectedRun
          ? React.createElement(PhaseList, {
              run: selectedRun,
              phases: selectedRun.phases,
              selectedIndex: phaseIndex,
            })
          : selectedRun && selectedPhase && selectedAgent
            ? React.createElement(AgentDetail, {
                run: selectedRun,
                phase: selectedPhase,
                agent: selectedAgent,
              })
            : React.createElement(
                ThemedText,
                { colorTheme: 'muted' },
                'No workflow run evidence recorded.',
              ),
      React.createElement(Divider, null),
      React.createElement(
        Box,
        { gap: 2 },
        React.createElement(KeyboardShortcutHint, { keys: ['Enter'], description: 'open' }),
        React.createElement(KeyboardShortcutHint, {
          keys: ['p'],
          description: actionLabel('pause'),
        }),
        React.createElement(KeyboardShortcutHint, {
          keys: ['r'],
          description: actionLabel('resume'),
        }),
        React.createElement(KeyboardShortcutHint, {
          keys: ['x'],
          description: actionLabel('stopRun'),
        }),
        React.createElement(KeyboardShortcutHint, {
          keys: ['a'],
          description: actionLabel('stopAgent'),
        }),
        React.createElement(KeyboardShortcutHint, {
          keys: ['R'],
          description: actionLabel('restartAgent'),
        }),
        React.createElement(KeyboardShortcutHint, {
          keys: ['s'],
          description: actionLabel('saveScript'),
        }),
        React.createElement(KeyboardShortcutHint, { keys: ['S'], description: 'save target' }),
        React.createElement(KeyboardShortcutHint, { keys: ['q'], description: 'back' }),
      ),
    ),
  );
}

function DecisionSummary({
  summary,
}: {
  summary: ReturnType<typeof deriveWorkflowRunDecisionSummary>;
}): React.JSX.Element {
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(ThemedText, { colorTheme: 'info', bold: true }, 'Decision Summary'),
    React.createElement(
      ThemedText,
      { colorTheme: 'foreground' },
      `Status: ${summary.status} | Owner: ${summary.owner}`,
    ),
    React.createElement(
      ThemedText,
      { colorTheme: summary.blocker === 'none' ? 'muted' : 'warning' },
      `Blocker: ${summary.blocker}`,
    ),
    React.createElement(
      ThemedText,
      { colorTheme: 'foreground' },
      `Next action: ${summary.nextAction}`,
    ),
  );
}

function SaveShareChooser({ selectedKey }: { selectedKey: string }): React.JSX.Element {
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(
      ThemedText,
      { colorTheme: 'info', bold: true },
      'Save/share workflow source',
    ),
    ...SAVE_TARGET_OPTIONS.map((option) =>
      React.createElement(
        ThemedText,
        { key: option.key, colorTheme: option.key === selectedKey ? 'accent' : 'muted' },
        `[${option.key}] ${option.label} - ${option.detail}`,
      ),
    ),
    React.createElement(
      ThemedText,
      { colorTheme: 'muted', dim: true },
      'This saves source only. It does not copy transcripts, secrets, or local evidence.',
    ),
  );
}

function RunList({
  runs,
  selectedIndex,
}: {
  runs: WorkflowRunProgressItem[];
  selectedIndex: number;
}): React.JSX.Element {
  if (runs.length === 0)
    return React.createElement(ThemedText, { colorTheme: 'muted' }, 'No workflow runs found.');
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    ...runs.map((run, index) =>
      React.createElement(
        Box,
        { key: run.runId, gap: 1 },
        React.createElement(Text, null, index === selectedIndex ? '>' : ' '),
        React.createElement(StatusIcon, { status: statusCategory(run.status) }),
        React.createElement(
          ThemedText,
          { colorTheme: index === selectedIndex ? 'accent' : 'foreground' },
          run.workflowName,
        ),
        React.createElement(ThemedText, { colorTheme: 'muted' }, run.runId),
        React.createElement(
          ThemedText,
          { colorTheme: 'muted' },
          `${run.status} ${run.currentPhase ?? 'no phase'} ${budgetLine(run)}`,
        ),
      ),
    ),
  );
}

function PhaseList({
  run,
  phases,
  selectedIndex,
}: {
  run: WorkflowRunProgressItem;
  phases: WorkflowPhaseProgressItem[];
  selectedIndex: number;
}): React.JSX.Element {
  return React.createElement(
    Box,
    { flexDirection: 'column', gap: 1 },
    React.createElement(
      ThemedText,
      { colorTheme: 'info' },
      `${run.workflowName} | ${run.status} | elapsed ${duration(run.elapsedMs)} | ${budgetLine(run)}`,
    ),
    ...phases.map((phase, index) =>
      React.createElement(
        Box,
        { key: phase.phase, flexDirection: 'column' },
        React.createElement(
          Box,
          { gap: 1 },
          React.createElement(Text, null, index === selectedIndex ? '>' : ' '),
          React.createElement(StatusIcon, { status: statusCategory(phase.status) }),
          React.createElement(
            ThemedText,
            { colorTheme: index === selectedIndex ? 'accent' : 'foreground' },
            phase.phase,
          ),
          React.createElement(
            ThemedText,
            { colorTheme: 'muted' },
            `agents ${phase.agentCount} | cached ${phase.cachedCount} | live ${phase.liveCount} | failed ${phase.failedCount} | tokens ${phase.tokenTotal}`,
          ),
        ),
        ...phase.agents.map((agent) =>
          React.createElement(
            Box,
            { key: `${phase.phase}-${agent.id}`, marginLeft: 3, gap: 1 },
            React.createElement(ThemedText, { colorTheme: 'muted' }, '-'),
            React.createElement(StatusIcon, { status: statusCategory(agent.status) }),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, agent.label),
            React.createElement(
              ThemedText,
              { colorTheme: 'muted' },
              `${agent.status} | ${agent.tokensUsed} tokens | replay ${agent.replayAvailable === false ? 'no' : 'yes'}`,
            ),
          ),
        ),
      ),
    ),
  );
}

function AgentDetail({
  run,
  phase,
  agent,
}: {
  run: WorkflowRunProgressItem;
  phase: WorkflowPhaseProgressItem;
  agent: WorkflowAgentProgressItem;
}): React.JSX.Element {
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(ThemedText, { colorTheme: 'info' }, `${run.workflowName} / ${phase.phase}`),
    React.createElement(
      ThemedText,
      { colorTheme: 'foreground' },
      `${agent.label}: ${agent.status}`,
    ),
    React.createElement(
      ThemedText,
      { colorTheme: 'muted' },
      `model ${agent.model ?? 'not recorded'} | runtime ${agent.runtimeProvider ?? 'not recorded'} | isolation ${agent.isolation ?? 'not recorded'} | tokens ${agent.tokensUsed}`,
    ),
    React.createElement(
      ThemedText,
      { colorTheme: 'muted' },
      `worktree ${agent.worktreePath ?? 'not recorded'}`,
    ),
    React.createElement(
      ThemedText,
      { colorTheme: 'muted' },
      `terminal ${agent.terminalReason ?? 'not recorded'}`,
    ),
    React.createElement(
      ThemedText,
      { colorTheme: agent.replayAvailable === false ? 'warning' : 'muted' },
      `replay ${agent.replayAvailable === false ? `unavailable: ${agent.replayUnavailableReason ?? 'not recorded'}` : 'available'}`,
    ),
    React.createElement(ThemedText, { colorTheme: 'foreground' }, `prompt: ${agent.promptSummary}`),
    agent.resultSummary
      ? React.createElement(
          ThemedText,
          { colorTheme: 'foreground' },
          `result: ${agent.resultSummary}`,
        )
      : null,
    agent.transcriptPath
      ? React.createElement(
          ThemedText,
          { colorTheme: 'muted' },
          `transcript: ${agent.transcriptPath}`,
        )
      : null,
    React.createElement(
      ThemedText,
      { colorTheme: 'muted' },
      'Agent stop uses a live runtime handle when available; restart records replay intent unless replay input is available.',
    ),
    ...agent.recentTools.map((tool) =>
      React.createElement(
        ThemedText,
        { key: `${tool.type}-${tool.name}-${tool.timestamp ?? ''}`, colorTheme: 'muted' },
        `tool ${tool.name}: ${tool.summary}`,
      ),
    ),
  );
}
