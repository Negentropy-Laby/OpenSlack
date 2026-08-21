package runnerbindingcontract

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
)

var authorityIdempotencyPattern = regexp.MustCompile(`^openslack\.workflow-control-authority\.v2\.[0-9a-f]{64}$`)

var stageFields = []string{
	"schema",
	"contractVersion",
	"profile",
	"phase",
	"direction",
	"companionSequence",
	"bindingId",
	"operation",
	"workspaceId",
	"jobId",
	"runId",
	"runnerAttemptId",
	"leaseId",
	"fencingToken",
	"route",
	"runnerAuthority",
	"target",
	"correlationId",
	"sentAt",
}

func ValidateStage(value any) (Record, error) {
	return validateStageWithSession(value, newBindingValidationSession(nil))
}

func validateStageWithSession(value any, session *bindingValidationSession) (Record, error) {
	record, err := closedRecord(value, stageFields, "$")
	if err != nil {
		return nil, err
	}
	operation, err := operationValue(record["operation"], "$/operation")
	if err != nil {
		return nil, err
	}
	route, err := validateRoute(record["route"], "$/route")
	if err != nil {
		return nil, err
	}
	runnerHead, err := validateRunnerHead(record["runnerAuthority"], operation, "$/runnerAuthority")
	if err != nil {
		return nil, err
	}
	target, message, err := validateTarget(record["target"], operation, "$/target")
	if err != nil {
		return nil, err
	}
	workspaceID, err := identifier(record["workspaceId"], "$/workspaceId")
	if err != nil {
		return nil, err
	}
	jobID, err := identifier(record["jobId"], "$/jobId")
	if err != nil {
		return nil, err
	}
	runID, err := identifier(record["runId"], "$/runId")
	if err != nil {
		return nil, err
	}
	runnerAttemptID, err := identifier(record["runnerAttemptId"], "$/runnerAttemptId")
	if err != nil {
		return nil, err
	}
	leaseID, err := identifier(record["leaseId"], "$/leaseId")
	if err != nil {
		return nil, err
	}
	fencingToken, err := integerValue(record["fencingToken"], "$/fencingToken", 1)
	if err != nil {
		return nil, err
	}
	if !leasedMessageIdentityMatches(
		message,
		workspaceID,
		jobID,
		runID,
		runnerAttemptID,
		leaseID,
		fencingToken,
		route,
		runnerHead,
	) {
		return nil, failure(ErrorIdentityMismatch, "$", "Stage identity does not match the exact future event.")
	}
	bindingID, err := identifier(record["bindingId"], "$/bindingId")
	if err != nil {
		return nil, err
	}
	expectedBindingID, err := DeriveBindingID(Record{
		"operation":                string(operation),
		"workspaceId":              workspaceID,
		"jobId":                    jobID,
		"runId":                    runID,
		"runnerAttemptId":          runnerAttemptID,
		"leaseId":                  leaseID,
		"fencingToken":             fencingToken,
		"route":                    route,
		"runnerAuthority":          runnerHead,
		"targetBodyHash":           target["messageDigest"],
		"targetEventId":            target["eventId"],
		"targetIdempotencyKey":     target["idempotencyKey"],
		"targetRequestFingerprint": target["requestFingerprint"],
		"targetSequence":           target["sequence"],
	})
	if err != nil {
		return nil, err
	}
	if bindingID != expectedBindingID {
		return nil, failure(ErrorHashMismatch, "$/bindingId", "Binding identity drifted.")
	}
	schema, err := literalString(record["schema"], StageSchema, "$/schema")
	if err != nil {
		return nil, err
	}
	contractVersion, err := literalString(record["contractVersion"], ContractVersion, "$/contractVersion")
	if err != nil {
		return nil, err
	}
	profile, err := literalString(record["profile"], FutureRuntimeProfile, "$/profile")
	if err != nil {
		return nil, err
	}
	phase, err := literalString(record["phase"], "stage_event", "$/phase")
	if err != nil {
		return nil, err
	}
	direction, err := literalString(record["direction"], "runner-to-control", "$/direction")
	if err != nil {
		return nil, err
	}
	companionSequence, err := literalInteger(record["companionSequence"], 1, "$/companionSequence")
	if err != nil {
		return nil, err
	}
	correlationID, err := identifier(record["correlationId"], "$/correlationId")
	if err != nil {
		return nil, err
	}
	sentAt, err := timestampValue(record["sentAt"], "$/sentAt")
	if err != nil {
		return nil, err
	}
	if message.CorrelationID != correlationID {
		return nil, failure(ErrorIdentityMismatch, "$/correlationId", "Stage correlation differs from the target event.")
	}
	result := Record{
		"schema":            schema,
		"contractVersion":   contractVersion,
		"profile":           profile,
		"phase":             phase,
		"direction":         direction,
		"companionSequence": companionSequence,
		"bindingId":         bindingID,
		"operation":         string(operation),
		"workspaceId":       workspaceID,
		"jobId":             jobID,
		"runId":             runID,
		"runnerAttemptId":   runnerAttemptID,
		"leaseId":           leaseID,
		"fencingToken":      fencingToken,
		"route":             route,
		"runnerAuthority":   runnerHead,
		"target":            target,
		"correlationId":     correlationID,
		"sentAt":            sentAt,
	}
	if err := session.byteBound(result, MaxFrameBytes, "$", true); err != nil {
		return nil, err
	}
	return result, nil
}

func validateRoute(value any, path string) (Record, error) {
	canonical, encodeErr := canonicalJSON(value)
	if encodeErr != nil {
		return nil, failure(ErrorInvalid, path, "Embedded authority route is invalid.")
	}
	route, err := authoritycontract.ValidateRouteJSON(canonical, path)
	if err != nil {
		var contractErr *authoritycontract.ContractError
		if errors.As(err, &contractErr) {
			if contractErr.Code == authoritycontract.ErrorIdentityMismatch {
				return nil, failure(ErrorAuthorityPlaneMismatch, path, "Authority route is inconsistent.")
			}
			code := ErrorInvalid
			if contractErr.Code == authoritycontract.ErrorUnknownField {
				code = ErrorUnknownField
			} else if contractErr.Code == authoritycontract.ErrorLimitExceeded {
				code = ErrorLimitExceeded
			}
			return nil, failure(code, contractErr.Path, "Embedded authority route is invalid.")
		}
		return nil, err
	}
	return Record{
		"backend":            route.Backend,
		"authority":          route.Authority,
		"routingEpoch":       route.RoutingEpoch,
		"authorityBuildHash": route.AuthorityBuildHash,
	}, nil
}

func validateRunnerHead(value any, operation Operation, path string) (Record, error) {
	record, err := closedRecord(value, []string{
		"expectedGlobalRunRevision",
		"acceptedGlobalRunRevision",
		"expectedResumeGeneration",
		"acceptedResumeGeneration",
	}, path)
	if err != nil {
		return nil, err
	}
	expectedRevision, err := integerValue(record["expectedGlobalRunRevision"], path+"/expectedGlobalRunRevision", 1)
	if err != nil {
		return nil, err
	}
	acceptedRevision, err := integerValue(record["acceptedGlobalRunRevision"], path+"/acceptedGlobalRunRevision", 1)
	if err != nil {
		return nil, err
	}
	expectedGeneration, err := integerValue(record["expectedResumeGeneration"], path+"/expectedResumeGeneration", 0)
	if err != nil {
		return nil, err
	}
	acceptedGeneration, err := integerValue(record["acceptedResumeGeneration"], path+"/acceptedResumeGeneration", 0)
	if err != nil {
		return nil, err
	}
	delta, err := RunnerHeadDelta(operation)
	if err != nil {
		return nil, err
	}
	if acceptedRevision != expectedRevision+delta.Revision {
		return nil, failure(ErrorRevisionConflict, path+"/acceptedGlobalRunRevision", "Coordinator run revision delta is invalid.")
	}
	if acceptedGeneration != expectedGeneration+delta.Generation {
		return nil, failure(ErrorResumeGenerationConflict, path+"/acceptedResumeGeneration", "Coordinator resume-generation delta is invalid.")
	}
	return Record{
		"expectedGlobalRunRevision": expectedRevision,
		"acceptedGlobalRunRevision": acceptedRevision,
		"expectedResumeGeneration":  expectedGeneration,
		"acceptedResumeGeneration":  acceptedGeneration,
	}, nil
}

func validateTarget(value any, operation Operation, path string) (Record, authoritycontract.Message, error) {
	record, err := closedRecord(value, []string{
		"schema", "eventId", "kind", "sequence", "body", "messageDigest", "idempotencyKey", "requestFingerprint",
	}, path)
	if err != nil {
		return nil, authoritycontract.Message{}, err
	}
	body, ok := record["body"].(string)
	if !ok || len([]byte(body)) > authoritycontract.MaxMessageBytes ||
		!strings.HasSuffix(body, "\n") || strings.HasSuffix(body, "\n\n") {
		return nil, authoritycontract.Message{}, failure(ErrorInvalid, path+"/body", "Target event body framing is invalid.")
	}
	message, prepared, prepareErr := prepareAuthorityMessageBytes([]byte(body))
	if prepareErr != nil {
		return nil, authoritycontract.Message{}, failure(ErrorInvalid, path+"/body", "Target event body is invalid: WorkflowControlAuthorityContractError.")
	}
	messageDigest, digestOK := record["messageDigest"].(string)
	idempotencyKey, keyOK := record["idempotencyKey"].(string)
	requestFingerprint, fingerprintOK := record["requestFingerprint"].(string)
	if prepared.Body != body || !digestOK || prepared.MessageDigest != messageDigest ||
		!keyOK || prepared.IdempotencyKey != idempotencyKey ||
		!fingerprintOK || prepared.RequestFingerprint != requestFingerprint {
		return nil, authoritycontract.Message{}, failure(ErrorHashMismatch, path, "Target prepared event binding drifted.")
	}
	expectedKind, err := ExpectedKind(operation)
	if err != nil {
		return nil, authoritycontract.Message{}, err
	}
	kind, kindOK := record["kind"].(string)
	if message.Kind != expectedKind || !kindOK || kind != string(expectedKind) {
		return nil, authoritycontract.Message{}, failure(ErrorAuthorityPlaneMismatch, path+"/kind", "Target event kind does not match the binding operation.")
	}
	eventID, eventOK := record["eventId"].(string)
	sequence, sequenceErr := integerValue(record["sequence"], path+"/sequence", 1)
	if !eventOK || message.EventID != eventID || sequenceErr != nil || message.Sequence == nil || *message.Sequence != sequence {
		return nil, authoritycontract.Message{}, failure(ErrorIdentityMismatch, path, "Target event identity drifted.")
	}
	schema, err := literalString(record["schema"], authoritycontract.PreparedSchema, path+"/schema")
	if err != nil {
		return nil, authoritycontract.Message{}, err
	}
	eventID, err = identifier(record["eventId"], path+"/eventId")
	if err != nil {
		return nil, authoritycontract.Message{}, err
	}
	messageDigest, err = hashValue(record["messageDigest"], path+"/messageDigest")
	if err != nil {
		return nil, authoritycontract.Message{}, err
	}
	idempotencyKey, err = textValue(record["idempotencyKey"], path+"/idempotencyKey", authorityIdempotencyPattern, 128)
	if err != nil {
		return nil, authoritycontract.Message{}, err
	}
	requestFingerprint, err = textValue(record["requestFingerprint"], path+"/requestFingerprint", fingerprintPattern, 71)
	if err != nil {
		return nil, authoritycontract.Message{}, err
	}
	return Record{
		"schema":             schema,
		"eventId":            eventID,
		"kind":               string(expectedKind),
		"sequence":           sequence,
		"body":               body,
		"messageDigest":      messageDigest,
		"idempotencyKey":     idempotencyKey,
		"requestFingerprint": requestFingerprint,
	}, message, nil
}

func leasedMessageIdentityMatches(
	message authoritycontract.Message,
	workspaceID, jobID, runID, attemptID, leaseID string,
	fencingToken int64,
	route, runnerHead Record,
) bool {
	return message.JobID != nil && message.WorkflowRunID != nil && message.AttemptID != nil &&
		message.LeaseID != nil && message.FencingToken != nil && message.AuthorityBackend != nil &&
		message.Authority != nil && message.RoutingEpoch != nil && message.AuthorityBuildHash != nil &&
		message.RunRevision != nil && message.ResumeGeneration != nil &&
		message.WorkspaceID == workspaceID && *message.JobID == jobID && *message.WorkflowRunID == runID &&
		*message.AttemptID == attemptID && *message.LeaseID == leaseID && *message.FencingToken == fencingToken &&
		*message.AuthorityBackend == route["backend"].(string) && *message.Authority == route["authority"].(string) &&
		*message.RoutingEpoch == route["routingEpoch"].(int64) && *message.AuthorityBuildHash == route["authorityBuildHash"].(string) &&
		*message.RunRevision == runnerHead["expectedGlobalRunRevision"].(int64) &&
		*message.ResumeGeneration == runnerHead["expectedResumeGeneration"].(int64)
}

func DeriveBindingID(identity Record) (string, error) {
	preimage := Record{
		"schema":                   "openslack.workflow_runner_authority_binding_identity.v1",
		"operation":                identity["operation"],
		"workspaceId":              identity["workspaceId"],
		"jobId":                    identity["jobId"],
		"runId":                    identity["runId"],
		"runnerAttemptId":          identity["runnerAttemptId"],
		"leaseId":                  identity["leaseId"],
		"fencingToken":             identity["fencingToken"],
		"route":                    identity["route"],
		"runnerAuthority":          identity["runnerAuthority"],
		"targetBodyHash":           identity["targetBodyHash"],
		"targetEventId":            identity["targetEventId"],
		"targetIdempotencyKey":     identity["targetIdempotencyKey"],
		"targetRequestFingerprint": identity["targetRequestFingerprint"],
		"targetSequence":           identity["targetSequence"],
	}
	canonical, err := canonicalJSON(preimage)
	if err != nil {
		return "", failure(ErrorInvalid, "$", err.Error())
	}
	digest := sha256.Sum256(append([]byte("openslack.workflow-runner-authority-binding.identity.v1\x00"), canonical...))
	return "WFRUNNER-BINDING-" + hex.EncodeToString(digest[:]), nil
}
