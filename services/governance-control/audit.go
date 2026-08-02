package governancecontrol

import "github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/canonicaljson"

type AuditEvent struct {
	EventID       string
	Type          string
	OccurredAt    string
	PlanID        string
	Kind          string
	ActorID       string
	WorkspaceID   string
	CorrelationID string
	State         State
	Revision      int
	EvidenceRefs  []string
}

var auditEventTypes = map[string]struct{}{
	"plan.previewed": {}, "plan.confirmed": {}, "plan.confirmation_rejected": {},
	"plan.cancelled": {}, "plan.expired": {}, "plan.execution_started": {},
	"plan.execution_completed": {}, "plan.execution_blocked": {},
	"plan.execution_failed": {}, "plan.reconciliation_required": {},
	"workflow.approval_decided": {},
}

func ValidateAuditJSON(input []byte) (AuditEvent, error) {
	value, err := parseValue(input)
	if err != nil {
		return AuditEvent{}, err
	}
	root, ok := value.(canonicaljson.Object)
	if !ok {
		return AuditEvent{}, fail(ErrorInvalid, "$", "audit event must be an object.")
	}
	if err := exactKeys(root,
		[]string{"schema", "eventId", "type", "occurredAt", "planId", "kind", "actorId", "workspaceId", "correlationId", "state", "revision", "evidenceRefs"},
		[]string{"details"}, "$", "audit"); err != nil {
		return AuditEvent{}, err
	}
	schema, err := requiredString(root, "schema", nil, 64, "$", "schema")
	if err != nil || schema != "openslack.governed_plan_audit.v1" {
		if err != nil {
			return AuditEvent{}, err
		}
		return AuditEvent{}, fail(ErrorInvalid, "$/schema", "Governed plan audit schema is invalid.")
	}
	eventID, err := requiredString(root, "eventId", identifierPattern, 512, "$", "eventId")
	if err != nil {
		return AuditEvent{}, err
	}
	eventType, err := requiredString(root, "type", nil, 128, "$", "type")
	if err != nil {
		return AuditEvent{}, err
	}
	if _, exists := auditEventTypes[eventType]; !exists {
		return AuditEvent{}, fail(ErrorInvalid, "$/type", "audit event type is invalid.")
	}
	occurredAt, err := requiredTimestamp(root, "occurredAt", "$")
	if err != nil {
		return AuditEvent{}, err
	}
	planID, err := requiredString(root, "planId", planIDPattern, 512, "$", "planId")
	if err != nil {
		return AuditEvent{}, err
	}
	kind, err := requiredString(root, "kind", kindPattern, 512, "$", "kind")
	if err != nil {
		return AuditEvent{}, err
	}
	actorID, err := requiredString(root, "actorId", identifierPattern, 512, "$", "actorId")
	if err != nil {
		return AuditEvent{}, err
	}
	workspaceID, err := requiredString(root, "workspaceId", identifierPattern, 512, "$", "workspaceId")
	if err != nil {
		return AuditEvent{}, err
	}
	correlationID, err := requiredString(root, "correlationId", identifierPattern, 512, "$", "correlationId")
	if err != nil {
		return AuditEvent{}, err
	}
	stateText, err := requiredString(root, "state", nil, 64, "$", "state")
	if err != nil {
		return AuditEvent{}, err
	}
	state := State(stateText)
	if _, exists := transitions[state]; !exists {
		return AuditEvent{}, fail(ErrorInvalid, "$/state", "state is invalid.")
	}
	revision, err := requiredInteger(root, "revision", 1, 9_007_199_254_740_991, "$")
	if err != nil {
		return AuditEvent{}, err
	}
	rawRefs, err := requiredArray(root, "evidenceRefs", "$")
	if err != nil {
		return AuditEvent{}, err
	}
	refs := make([]string, len(rawRefs))
	for index, raw := range rawRefs {
		text, ok := raw.(string)
		if !ok || text == "" || len([]byte(text)) > MaxEvidenceRefBytes {
			return AuditEvent{}, fail(ErrorInvalid, "$/evidenceRefs", "evidenceRef is invalid.")
		}
		refs[index] = text
	}
	return AuditEvent{
		EventID: eventID, Type: eventType, OccurredAt: occurredAt, PlanID: planID,
		Kind: kind, ActorID: actorID, WorkspaceID: workspaceID,
		CorrelationID: correlationID, State: state, Revision: revision, EvidenceRefs: refs,
	}, nil
}
