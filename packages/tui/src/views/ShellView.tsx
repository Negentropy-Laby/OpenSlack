import React, { useState, useEffect } from 'react';
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
import useApp from '../ink/hooks/use-app.js';
import useInput from '../ink/hooks/use-input.js';
import ThemedText from '../design-system/ThemedText.js';
import Divider from '../design-system/Divider.js';
import Pane from '../design-system/Pane.js';
import ListItem from '../design-system/ListItem.js';
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js';
import { NavigationProvider, useNavigation, HOME_ROUTE } from '../navigation/context.js';
import type { Route } from '../navigation/router.js';
import { mapHomeToViewModel } from '../view-models/home.js';
import { mapApprovalCenterToViewModel } from '../view-models/approval-center.js';
import { mapWorkflowGalleryToViewModel } from '../view-models/workflow-gallery.js';
import { mapIssuesPrToViewModel } from '../view-models/issues-pr.js';
import { mapDigestToViewModel } from '../view-models/digest.js';
import { mapHandoffListToViewModel } from '../view-models/handoff.js';
import { mapDecisionListToViewModel } from '../view-models/decision.js';
import { mapRoomToViewModel } from '../view-models/room.js';
import type { RoomViewModel } from '../view-models/room.js';
import { mapProfileToViewModel } from '../view-models/profile.js';
import type { ProfileViewModel } from '../view-models/profile.js';
import {
  mapConversationListToViewModel,
  mapThreadToViewModel,
} from '../view-models/conversation.js';
import { mapSubagentToViewModel } from '../view-models/agent-detail.js';
import { mapAgentRunToViewModel } from '../view-models/agent-run.js';
import { mapWorkflowRunsToViewModel } from '../view-models/workflow-runs.js';
import type { SubagentDefinition } from '@openslack/kernel';
import { createRunStore } from '@openslack/agent-runtime';
import type { ShellViewData, TuiActionHandlers } from './render-shell.js';

import HomeView from './HomeView.js';
import ApprovalCenterView from './ApprovalCenterView.js';
import WorkflowWorkbenchView from './WorkflowWorkbenchView.js';
import IssuesPrView from './IssuesPrView.js';
import DashboardView from './DashboardView.js';
import PrQueueView from './PrQueueView.js';
import StatusView from './StatusView.js';
import ActivityView from './ActivityView.js';
import DigestView from './DigestView.js';
import HandoffListView from './HandoffListView.js';
import DecisionListView from './DecisionListView.js';
import RoomView from './RoomView.js';
import WorkflowLifecycleViewWrapper from './WorkflowLifecycleViewWrapper.js';
import ProfileView from './ProfileView.js';
import ConversationListView from './ConversationListView.js';
import ThreadView from './ThreadView.js';
import SubagentDetailView from './SubagentDetailView.js';
import AgentRunDetailView from './AgentRunDetailView.js';
import AgentRuntimeDiagnosticsView from './AgentRuntimeDiagnosticsView.js';
import WorkflowRunsView from './WorkflowRunsView.js';

/**
 * A view that hasn't been wired to live data yet.
 * Shows the view name and a "press q to go back" prompt.
 */
function PlaceholderView({ route }: { route: Route }): React.JSX.Element {
  const { pop } = useNavigation();

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      pop();
    }
  });

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    React.createElement(
      ThemedText,
      { colorTheme: 'accent', bold: true },
      `OpenSlack / ${route.view}`,
    ),
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      ThemedText,
      { colorTheme: 'muted' },
      `View "${route.view}" is not yet connected to live data.`,
    ),
    React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, 'Press [q] to go back'),
  );
}

/**
 * Activity view wrapper — uses the full ActivityView component with proper data.
 * Falls back to dashboard recentActivity when no full activity data is available.
 */
function ActivityViewWrapper({ data }: { data?: ShellViewData }): React.JSX.Element {
  const { pop } = useNavigation();

  const activityItems = data?.dashboard?.recentActivity ?? [];

  if (activityItems.length === 0) {
    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, 'OpenSlack / Activity'),
      React.createElement(Divider, { length: 40 }),
      React.createElement(ThemedText, { colorTheme: 'muted' }, 'No recent activity.'),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
      ),
    );
  }

  return React.createElement(ActivityView, {
    model: {
      title: 'Activity Feed',
      periodHours: 24,
      totalEvents: activityItems.length,
      events: activityItems.map((a) => ({
        time: a.time,
        type: a.type,
        summary: a.summary,
        actor: a.actor,
        objectKind: '',
        objectId: '',
      })),
      today: activityItems.map((a) => ({
        time: a.time,
        type: a.type,
        summary: a.summary,
        actor: a.actor,
        objectKind: '',
        objectId: '',
      })),
      yesterday: [],
      older: [],
    },
    onBack: pop,
  });
}

/**
 * Room view wrapper — handles async room data loading with useEffect + useState.
 */
function RoomViewWrapper({
  roomId,
  onBack,
}: {
  roomId: string;
  onBack?: () => void;
}): React.JSX.Element {
  const [model, setModel] = useState<RoomViewModel | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { buildRoomView, readEvents } = await import('@openslack/collaboration');
        const events = readEvents();
        const room = buildRoomView(roomId, events);
        if (!cancelled) {
          if (room) {
            setModel(mapRoomToViewModel(room));
          }
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  if (loading) {
    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `Room: ${roomId}`),
      React.createElement(Divider, { length: 40 }),
      React.createElement(ThemedText, { colorTheme: 'muted' }, 'Loading room data...'),
    );
  }

  if (!model) {
    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `Room: ${roomId}`),
      React.createElement(Divider, { length: 40 }),
      React.createElement(ThemedText, { colorTheme: 'muted' }, 'Room data unavailable.'),
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
      ),
    );
  }

  return React.createElement(RoomView, { model, onBack });
}

/**
 * Maps a route to a rendered view component.
 */
function ViewRouter({ data }: { data?: ShellViewData }): React.JSX.Element {
  const { current, pop, push } = useNavigation();

  switch (current.view) {
    case 'home': {
      const model = mapHomeToViewModel({ shellData: data });
      return React.createElement(HomeView, { model, actionHandlers: data?.actionHandlers });
    }
    case 'dashboard': {
      if (data?.dashboard) {
        return React.createElement(DashboardView, { model: data.dashboard, onBack: pop });
      }
      return React.createElement(PlaceholderView, { route: current });
    }
    case 'pr-queue': {
      if (data?.prQueue) {
        return React.createElement(PrQueueView, { model: data.prQueue, onBack: pop });
      }
      const issuesPrModel = mapIssuesPrToViewModel({ tab: 'prs' });
      return React.createElement(IssuesPrView, { model: issuesPrModel });
    }
    case 'approvals': {
      const model = data?.approvals ?? mapApprovalCenterToViewModel();
      return React.createElement(ApprovalCenterView, {
        model,
        actionHandlers: data?.actionHandlers,
      });
    }
    case 'workflow-preview':
    case 'workflows': {
      const galleryModel = data?.workflowGallery ?? mapWorkflowGalleryToViewModel();
      return React.createElement(WorkflowWorkbenchView, {
        galleryModel,
        actionHandlers: data?.actionHandlers,
      });
    }
    case 'status': {
      if (data?.status) {
        return React.createElement(StatusView, { model: data.status, onBack: pop });
      }
      return React.createElement(PlaceholderView, { route: current });
    }
    case 'activity': {
      return React.createElement(ActivityViewWrapper, { data });
    }
    case 'digest': {
      if (data?.digest) {
        return React.createElement(DigestView, { model: data.digest, onBack: pop });
      }
      return React.createElement(PlaceholderView, { route: current });
    }
    case 'handoffs': {
      if (data?.handoffs) {
        return React.createElement(HandoffListView, { model: data.handoffs, onBack: pop });
      }
      return React.createElement(PlaceholderView, { route: current });
    }
    case 'decisions': {
      if (data?.decisions) {
        return React.createElement(DecisionListView, { model: data.decisions, onBack: pop });
      }
      return React.createElement(PlaceholderView, { route: current });
    }
    case 'workflow-lifecycle': {
      const workflowName = current.params?.workflowName as string | undefined;
      if (workflowName) {
        const baseData = data?.workflowLifecycleBase?.[workflowName];
        return React.createElement(WorkflowLifecycleViewWrapper, {
          workflowName,
          baseData,
          loadLifecycle: data?.workflowLifecycleLoader,
          actionHandlers: data?.actionHandlers,
          onBack: pop,
        });
      }
      return React.createElement(PlaceholderView, { route: current });
    }
    case 'workflow-runs': {
      const model =
        data?.workflowRuns ?? mapWorkflowRunsToViewModel(data?.workflowRunProgress ?? []);
      return React.createElement(WorkflowRunsView, {
        model,
        actionHandlers: data?.actionHandlers,
        onBack: pop,
      });
    }
    case 'room': {
      const roomId = current.params?.roomId as string | undefined;
      if (roomId) {
        return React.createElement(RoomViewWrapper, { roomId, onBack: pop });
      }
      return React.createElement(PlaceholderView, { route: current });
    }
    case 'profile': {
      const profileModel = data?.profile ?? mapProfileToViewModel();
      return React.createElement(ProfileView, {
        model: profileModel,
        onBack: pop,
        onAction: async (actionId: string) => {
          const handlers = data?.actionHandlers?.profileSync;
          if (!handlers) return;
          switch (actionId) {
            case 'check':
              return handlers.checkProfileSync();
            case 'preview':
              return handlers.previewProfileSync();
            case 'dryrun':
              return handlers.dryRunProfileSync();
            case 'create-pr':
              return handlers.createProfileSyncPR();
            case 'open-pr':
              if (profileModel.pendingPR?.url) {
                return handlers.openProfileSyncPR(profileModel.pendingPR.url);
              }
              return;
            case 'failure-issue':
              return handlers.createProfileSyncFailureIssue('Manual failure report from TUI');
          }
        },
      });
    }
    case 'agent-runtime': {
      if (data?.agentRuntime) {
        return React.createElement(AgentRuntimeDiagnosticsView, {
          model: data.agentRuntime,
          onBack: pop,
        });
      }
      return React.createElement(PlaceholderView, { route: current });
    }
    case 'prs':
    case 'issues': {
      const issuesPrModel = mapIssuesPrToViewModel({ tab: current.view as 'issues' | 'prs' });
      return React.createElement(IssuesPrView, { model: issuesPrModel });
    }
    case 'conversations': {
      const threads = data?.conversations?.threads ?? [];
      const convModel = mapConversationListToViewModel(threads);
      return React.createElement(ConversationListView, {
        model: convModel,
        onSelect: (item: { id: string }) => {
          // Navigate to thread view with the selected conversation id
          push({ view: 'conversation-thread', params: { threadId: item.id } });
        },
        onBack: pop,
      });
    }
    case 'conversation-thread': {
      const threadId = current.params?.threadId as string | undefined;
      if (threadId) {
        const threadData = data?.conversations?.threads?.find((t) => t.id === threadId);
        const messages = data?.conversations?.messages?.[threadId] ?? [];
        if (threadData) {
          const threadModel = mapThreadToViewModel(threadData, messages);
          return React.createElement(ThreadView, { model: threadModel, onBack: pop });
        }
      }
      return React.createElement(PlaceholderView, { route: current });
    }
    case 'agent-detail': {
      const agentDef = current.params?.agent as SubagentDefinition | undefined;
      if (agentDef) {
        const agentModel = mapSubagentToViewModel(agentDef);
        return React.createElement(SubagentDetailView, { model: agentModel, onBack: pop });
      }
      return React.createElement(PlaceholderView, { route: current });
    }
    case 'agent-run-detail': {
      const runState = current.params?.runState as
        | import('@openslack/agent-runtime').AgentRunState
        | undefined;
      const runId = current.params?.runId as string | undefined;
      const resolvedRunState =
        runState ??
        (runId
          ? (createRunStore(data?.rootDir ?? process.cwd()).getRun(runId) ?? undefined)
          : undefined);
      if (resolvedRunState) {
        const runModel = mapAgentRunToViewModel(resolvedRunState, {
          rootDir: data?.rootDir ?? process.cwd(),
        });
        return React.createElement(AgentRunDetailView, { model: runModel, onBack: pop });
      }
      return React.createElement(PlaceholderView, { route: current });
    }
    default:
      return React.createElement(PlaceholderView, { route: current });
  }
}

/**
 * The shell wraps the entire navigable TUI.
 * NavigationProvider manages the router state.
 * ViewRouter renders the current view using pre-built view models.
 */
export default function ShellView({ data }: { data?: ShellViewData }): React.JSX.Element {
  return React.createElement(NavigationProvider, null, React.createElement(ViewRouter, { data }));
}
