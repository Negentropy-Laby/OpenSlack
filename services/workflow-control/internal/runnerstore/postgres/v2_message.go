package postgres

import "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"

// prepareV2Message converts the typed construction form to the closed JSON
// object form owned by authoritycontract. ValidateMessage intentionally accepts
// only JSON-shaped records, so passing a Go struct directly would bypass the
// contract's exact object/type checks and is rejected.
func prepareV2Message(message authoritycontract.Message) (authoritycontract.PreparedMessage, error) {
	return authoritycontract.PrepareMessage(map[string]any{
		"schema":             message.Schema,
		"protocolVersion":    message.ProtocolVersion,
		"kind":               string(message.Kind),
		"workspaceId":        message.WorkspaceID,
		"jobId":              optionalString(message.JobID),
		"workflowRunId":      optionalString(message.WorkflowRunID),
		"attemptId":          optionalString(message.AttemptID),
		"leaseId":            optionalString(message.LeaseID),
		"fencingToken":       optionalInt64(message.FencingToken),
		"sequence":           optionalInt64(message.Sequence),
		"authorityBackend":   optionalString(message.AuthorityBackend),
		"authority":          optionalString(message.Authority),
		"routingEpoch":       optionalInt64(message.RoutingEpoch),
		"authorityBuildHash": optionalString(message.AuthorityBuildHash),
		"runRevision":        optionalInt64(message.RunRevision),
		"resumeGeneration":   optionalInt64(message.ResumeGeneration),
		"eventId":            message.EventID,
		"correlationId":      message.CorrelationID,
		"sentAt":             message.SentAt,
		"payload":            message.Payload,
	})
}

func optionalString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func optionalInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}
