package authoritycontract

func PrepareMessage(value any) (PreparedMessage, error) {
	message, err := ValidateMessage(value)
	if err != nil {
		return PreparedMessage{}, err
	}
	direction, err := DirectionForKind(message.Kind)
	if err != nil {
		return PreparedMessage{}, err
	}
	canonical, err := CanonicalJSON(message)
	if err != nil {
		return PreparedMessage{}, failure(ErrorInvalid, "$", err.Error())
	}
	bodyBytes := append(append([]byte(nil), canonical...), '\n')
	digest := sha256Hex(bodyBytes)
	fingerprintValue := map[string]any{
		"schema": FingerprintSchema, "direction": direction, "kind": message.Kind,
		"protocolVersion": message.ProtocolVersion, "workspaceId": message.WorkspaceID,
		"jobId": message.JobID, "workflowRunId": message.WorkflowRunID, "attemptId": message.AttemptID,
		"leaseId": message.LeaseID, "fencingToken": message.FencingToken, "sequence": message.Sequence,
		"authorityBackend": message.AuthorityBackend, "authority": message.Authority,
		"routingEpoch": message.RoutingEpoch, "authorityBuildHash": message.AuthorityBuildHash,
		"runRevision": message.RunRevision, "resumeGeneration": message.ResumeGeneration, "bodyHash": digest,
	}
	fingerprintCanonical, err := CanonicalJSON(fingerprintValue)
	if err != nil {
		return PreparedMessage{}, failure(ErrorInvalid, "$", err.Error())
	}
	return PreparedMessage{
		Schema: PreparedSchema, Direction: direction, Body: string(bodyBytes), MessageDigest: digest,
		IdempotencyKey: IdempotencyPrefix + digest, RequestFingerprint: "sha256:" + sha256Hex(fingerprintCanonical),
	}, nil
}
