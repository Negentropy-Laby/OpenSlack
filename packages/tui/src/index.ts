// @openslack/tui — Public API
// Ink engine is internal; only render functions and types are exported.

export { default as render, renderSync, createRoot } from './ink/root.js';
export type { Instance, RenderOptions, Root } from './ink/root.js';

export { default as Box } from './ink/components/Box.js';
export { default as Text } from './ink/components/Text.js';
export { default as Newline } from './ink/components/Newline.js';
export { default as Spacer } from './ink/components/Spacer.js';

export { default as useApp } from './ink/hooks/use-app.js';
export { default as useInput } from './ink/hooks/use-input.js';
export { default as useStdin } from './ink/hooks/use-stdin.js';
export { useInterval } from './ink/hooks/use-interval.js';

// Design system
export { themes, resolveTheme } from './design-system/theme.js';
export type { Theme, ThemeMode, ThemeColorKey } from './design-system/theme.js';
export { ThemeProvider, useTheme } from './design-system/ThemeProvider.js';
export { default as ThemedBox } from './design-system/ThemedBox.js';
export type { ThemedBoxProps } from './design-system/ThemedBox.js';
export { default as ThemedText } from './design-system/ThemedText.js';
export type { ThemedTextProps } from './design-system/ThemedText.js';
export { default as StatusIcon, categorizeStatus } from './design-system/StatusIcon.js';
export type { StatusCategory, StatusIconProps } from './design-system/StatusIcon.js';
export { default as ProgressBar } from './design-system/ProgressBar.js';
export type { ProgressBarProps } from './design-system/ProgressBar.js';
export { default as Divider } from './design-system/Divider.js';
export type { DividerProps } from './design-system/Divider.js';
export { default as ListItem } from './design-system/ListItem.js';
export type { ListItemProps } from './design-system/ListItem.js';
export { default as Pane } from './design-system/Pane.js';
export type { PaneProps } from './design-system/Pane.js';
export { default as KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
export type { KeyboardShortcutHintProps } from './design-system/KeyboardShortcutHint.js';

export { default as SelectableList } from './design-system/SelectableList.js';
export type { SelectableListItem, SelectableListProps } from './design-system/SelectableList.js';

// Action dispatch
export { TuiActionCategory, TuiRiskLevel, TuiActionStatus, REQUIRES_CONFIRMATION } from './actions/types.js';
export type { TuiAction, TuiActionResult, TuiActionState } from './actions/types.js';
export { useActionDispatch } from './actions/use-action-dispatch.js';
export type { UseActionDispatchReturn } from './actions/use-action-dispatch.js';
export type { TuiActionHandlers, ApprovalExecutionParams } from './views/render-shell.js';

// Design system — action UI
export { default as ConfirmationDialog } from './design-system/ConfirmationDialog.js';
export type { ConfirmationDialogProps } from './design-system/ConfirmationDialog.js';
export { default as ActionStatus } from './design-system/ActionStatus.js';
export type { ActionStatusProps } from './design-system/ActionStatus.js';

// Infrastructure
export { isTuiSupported } from './capabilities.js';
export { sanitizeTerminalText } from './sanitize.js';
export { renderTui } from './render.js';
export type { RenderTuiOptions } from './render.js';

// Plain-text fallback renderer
export {
  renderPlain,
  renderPlainHome,
  renderPlainDoctor,
  renderPlainPrQueue,
  renderPlainProfile,
  renderPlainWorkflowLifecycle,
  renderPlainWorkflowWorkbench,
  renderPlainDashboard,
} from './plain-render.js';

// Views
export { renderDashboardTui } from './views/render-dashboard.js';
export type { DashboardViewModel } from './view-models/dashboard.js';
export { mapDashboardToViewModel } from './view-models/dashboard.js';
export { renderRoomTui } from './views/render-room.js';
export type { RoomViewModel } from './view-models/room.js';
export { renderDoctorTui } from './views/render-doctor.js';
export type { DoctorReportInput, DoctorViewModel, ProfileSyncGate } from './view-models/doctor.js';
export { renderSetupTui } from './views/render-setup.js';
export type { SetupViewModel, SetupReadiness } from './view-models/setup.js';
export { renderWorkflowPreviewTui } from './views/render-workflow-preview.js';
export type { WorkflowPreviewViewModel, WorkflowPreviewStepViewModel } from './view-models/workflow-preview.js';
export { renderPrQueueTui } from './views/render-pr-queue.js';
export type { PrQueueInputItem, PrQueueViewModel } from './view-models/pr-queue.js';
export { mapPrQueueToViewModel } from './view-models/pr-queue.js';
export { renderStatusTui } from './views/render-status.js';
export type { StatusViewModel } from './view-models/status.js';
export { mapStatusToViewModel } from './view-models/status.js';

// Navigation shell
export { renderShellTui } from './views/render-shell.js';
export type { ShellViewData, WorkflowLifecycleBaseData, WorkflowLifecycleLoader } from './views/render-shell.js';
export { NavigationProvider, useNavigation, HOME_ROUTE } from './navigation/context.js';
export type { Route, RouterState, RouterActions } from './navigation/router.js';
export type { HomeViewModel } from './view-models/home.js';
export { mapHomeToViewModel } from './view-models/home.js';
export type { ApprovalCenterViewModel, ApprovalItem, ApprovalCategory } from './view-models/approval-center.js';
export { mapApprovalCenterToViewModel, getCategoryLabel } from './view-models/approval-center.js';
export type { WorkflowGalleryViewModel, WorkflowGalleryItem, WorkflowDetailViewModel } from './view-models/workflow-gallery.js';
export { mapWorkflowGalleryToViewModel, mapWorkflowDetailToViewModel } from './view-models/workflow-gallery.js';
export type { WorkflowLifecycleViewModel, LifecycleStage, PhaseIssueItem, CanonicalStageSlot, CanonicalStageKey, CanonicalStageStatus } from './view-models/workflow-lifecycle.js';
export { mapWorkflowLifecycleToViewModel, mapCanonicalStages } from './view-models/workflow-lifecycle.js';
export type { IssuesPrViewModel, IssueItem, PrItem } from './view-models/issues-pr.js';
export { mapIssuesPrToViewModel } from './view-models/issues-pr.js';

// Activity
export { renderActivityTui } from './views/render-activity.js';
export type { ActivityViewModel, ActivityEventViewModel } from './view-models/activity.js';
export { mapActivityToViewModel } from './view-models/activity.js';

// Digest
export { renderDigestTui } from './views/render-digest.js';
export type { DigestViewModel, DigestGroupViewModel, DigestEventViewModel } from './view-models/digest.js';
export { mapDigestToViewModel } from './view-models/digest.js';

// Handoff
export { renderHandoffListTui, renderHandoffDetailTui } from './views/render-handoff.js';
export type { HandoffListViewModel, HandoffListItemViewModel, HandoffDetailViewModel } from './view-models/handoff.js';
export { mapHandoffListToViewModel, mapHandoffToViewModel } from './view-models/handoff.js';

// Decision
export { renderDecisionListTui, renderDecisionDetailTui } from './views/render-decision.js';
export type { DecisionListViewModel, DecisionListItemViewModel, DecisionDetailViewModel } from './view-models/decision.js';
export { mapDecisionListToViewModel, mapDecisionToViewModel } from './view-models/decision.js';

// Profile
export type { ProfileViewModel, ProfileSyncDetails, ProfileFailureDetails, ProfileSyncMode } from './view-models/profile.js';
export { mapProfileToViewModel } from './view-models/profile.js';
