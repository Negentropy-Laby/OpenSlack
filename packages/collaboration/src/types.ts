export type ActorKind = 'human' | 'agent' | 'system' | 'github' | 'chat';
export type Provider = 'cli' | 'slack' | 'webhook' | 'github';
export type ObjectKind = 'issue' | 'pr' | 'plan' | 'module' | 'agent' | 'handoff' | 'decision' | 'workspace' | 'workflow';
export type SourceKind = 'github' | 'openslack' | 'chat' | 'prms' | 'operator' | 'governance';
export type RiskLevel = 'none' | 'low' | 'medium' | 'high';
export type Severity = 'info' | 'notice' | 'warning' | 'critical';
export type Visibility = 'local' | 'workspace' | 'chat';

export type TaskEvent =
  | 'task.created' | 'task.claimed' | 'task.blocked' | 'task.done' | 'task.released' | 'task.expired';

export type PRMSEvent =
  | 'pr.opened' | 'pr.doctor.ready' | 'pr.doctor.blocked'
  | 'pr.review.commented' | 'pr.watch.started' | 'pr.watch.completed'
  | 'pr.merge.requested' | 'pr.merge.confirmed' | 'pr.merge.completed' | 'pr.merge.blocked';

export type OperatorEvent =
  | 'operator.intent.parsed' | 'operator.plan.created' | 'operator.plan.blocked'
  | 'operator.execution.started' | 'operator.execution.completed' | 'operator.execution.failed';

export type ChatEvent =
  | 'chat.message.received' | 'chat.message.duplicate_dropped'
  | 'chat.plan.confirmation_requested' | 'chat.plan.confirmed' | 'chat.plan.cancelled' | 'chat.plan.expired';

export type GovernanceEvent =
  | 'governance.audit.passed' | 'governance.audit.failed'
  | 'governance.direct_commit.explained' | 'governance.direct_commit.unexplained';

export type CollaborationObjectEvent =
  | 'handoff.created' | 'handoff.accepted' | 'handoff.closed'
  | 'decision.recorded' | 'decision.superseded'
  | 'room.summarized' | 'digest.generated'
  | 'workflow.previewed' | 'workflow.started' | 'workflow.completed' | 'workflow.blocked'
  | 'profile_sync.triggered' | 'profile_sync.queued' | 'profile_sync.started' | 'profile_sync.completed' | 'profile_sync.failed';

export type RepairEvent =
  | 'repair.previewed' | 'repair.applied' | 'repair.failed';

export type NotificationEvent =
  | 'notification.sent' | 'notification.failed';

export type CollaborationEventType =
  | TaskEvent
  | PRMSEvent
  | OperatorEvent
  | ChatEvent
  | GovernanceEvent
  | CollaborationObjectEvent
  | RepairEvent
  | NotificationEvent;

export interface CollaborationActor {
  id: string;
  kind: ActorKind;
  provider?: Provider;
}

export interface CollaborationObject {
  kind: ObjectKind;
  id: string;
  url?: string;
}

export interface CollaborationSource {
  kind: SourceKind;
  ref: string;
}

export interface NextAction {
  owner: string;
  action: string;
  command?: string;
  url?: string;
}

export interface CollaborationEvent {
  id: string;
  schema: 'openslack.collaboration_event.v1';
  timestamp: string;
  type: CollaborationEventType;
  actor: CollaborationActor;
  object: CollaborationObject;
  source: CollaborationSource;
  summary: string;
  owner?: { id: string; kind: 'human' | 'agent' | 'system' };
  nextAction?: NextAction;
  risk?: RiskLevel;
  severity?: Severity;
  visibility: Visibility;
  correlationId?: string;
  parentEventId?: string;
  redacted: boolean;
  containsSensitiveData: false;
  metadata?: Record<string, unknown>;
}

export type EventFilter = {
  type?: CollaborationEventType | CollaborationEventType[];
  actorId?: string;
  actorKind?: ActorKind;
  objectKind?: ObjectKind;
  objectId?: string;
  sourceKind?: SourceKind;
  since?: Date;
  until?: Date;
  correlationId?: string;
  risk?: RiskLevel;
  severity?: Severity;
  visibility?: Visibility;
};
