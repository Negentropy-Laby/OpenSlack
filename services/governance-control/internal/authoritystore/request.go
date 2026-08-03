package authoritystore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"

	governance "github.com/Negentropy-Laby/OpenSlack/services/governance-control"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore"
)

const maxSafeInteger = int64(9_007_199_254_740_991)

var (
	identifierPattern  = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$`)
	planIDPattern      = regexp.MustCompile(`^GPLAN-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	hashPattern        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	fingerprintPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	idempotencyPattern = regexp.MustCompile(`^openslack\.governance-authority\.v1\.[0-9a-f]{64}$`)
)

func PrepareRequest(body []byte, callerID, workspaceID, routingEpoch, expectedBuild string) (PreparedRequest, error) {
	if len(body) == 0 || len(body) > MaxRequestBytes {
		return PreparedRequest{}, Failure(ErrorInputInvalid, "request body exceeds the byte limit", nil)
	}
	epoch, err := parseRoutingEpoch(routingEpoch)
	if !identifierPattern.MatchString(callerID) || !identifierPattern.MatchString(workspaceID) ||
		err != nil || !hashPattern.MatchString(expectedBuild) {
		return PreparedRequest{}, Failure(ErrorInputInvalid, "authority request headers are invalid", nil)
	}
	value, err := canonicaljson.Parse(body, canonicaljson.Limits{MaxDepth: governance.MaxDepth + 5, MaxNodes: governance.MaxNodes + 64, MaxStringLength: governance.MaxStringBytes})
	if err != nil {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "parse strict authority request JSON", err)
	}
	encoded, err := canonicaljson.Encode(value)
	if err != nil || !bytes.Equal(append(encoded, '\n'), body) {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "request is not exact canonical JSON plus LF", err)
	}
	root, ok := value.(canonicaljson.Object)
	if !ok || !exactKeys(root, []string{"schema", "operation", "workspaceId", "planId", "expectedRevision", "route", "record"}) {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "authority request envelope is not closed", nil)
	}
	operation := Operation(stringValue(root["operation"]))
	schema := stringValue(root["schema"])
	if (operation == OperationAccept && schema != AcceptSchema) || (operation != OperationAccept && schema != TransitionSchema) || !validOperation(operation) {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "authority request schema or operation is invalid", nil)
	}
	bodyWorkspace := stringValue(root["workspaceId"])
	planID := stringValue(root["planId"])
	expectedRevision, ok := safeInteger(root["expectedRevision"], 0)
	if bodyWorkspace != workspaceID || !planIDPattern.MatchString(planID) || !ok || expectedRevision > maxSafeInteger-1 {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "authority request identity or revision is invalid", nil)
	}
	routeObject, ok := root["route"].(canonicaljson.Object)
	if !ok || !exactKeys(routeObject, []string{"backend", "authority", "routingEpoch"}) {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "authority route is not closed", nil)
	}
	bodyEpoch, epochOK := safeInteger(routeObject["routingEpoch"], 1)
	route := Route{Backend: stringValue(routeObject["backend"]), Authority: stringValue(routeObject["authority"]), RoutingEpoch: bodyEpoch}
	if route.Backend != Backend || route.Authority != Authority || !epochOK || route.RoutingEpoch != epoch {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "only the exact Go authority route is accepted", nil)
	}
	recordObject, ok := root["record"].(canonicaljson.Object)
	if !ok {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "authority request record must be an object", nil)
	}
	recordBytes, err := canonicaljson.Encode(recordObject)
	if err != nil {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "encode governed plan record", err)
	}
	recordBytes = append(recordBytes, '\n')
	record, err := governance.ValidateCanonicalRecordBytes(recordBytes)
	if err != nil {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "validate governed plan record", err)
	}
	projection, err := governance.Project(record)
	if err != nil || projection.PlanID != planID || projection.WorkspaceID != workspaceID {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "governed plan record does not bind request identity", err)
	}
	digest := sha256.Sum256(recordBytes)
	prepared := PreparedRequest{
		Schema: schema, Operation: operation, CallerID: callerID, WorkspaceID: workspaceID,
		PlanID: planID, ExpectedRevision: expectedRevision, ExpectedServiceBuild: expectedBuild,
		Route: route, Record: record, RecordBytes: recordBytes, RecordHash: hex.EncodeToString(digest[:]),
		TargetRevision: int64(projection.Revision), TargetState: projection.State,
		CorrelationID: projection.CorrelationID, ExactBody: append([]byte(nil), body...),
	}
	if projection.Execution != nil {
		prepared.ExecutionID = projection.Execution.ExecutionID
	}
	return prepared, nil
}

func ValidateInitial(prepared PreparedRequest) error {
	if prepared.Operation != OperationAccept || prepared.ExpectedRevision != 0 || prepared.TargetRevision != 1 || prepared.TargetState != governance.StatePending {
		return Failure(ErrorConflict, "initial record must create pending revision one from expected revision zero", nil)
	}
	return nil
}

func ValidateTransition(prepared PreparedRequest, previous []byte) error {
	if prepared.Operation == OperationAccept {
		return Failure(ErrorConflict, "accept cannot replace an existing route", nil)
	}
	evaluation := shadowstore.EvaluateRecord(shadowstore.PreparedObservation{
		ExpectedRevision: prepared.ExpectedRevision, RecordRevision: prepared.TargetRevision,
		Record: prepared.Record, RecordBytes: prepared.RecordBytes, RecordHash: prepared.RecordHash,
	}, previous)
	if evaluation.Parity != shadowstore.ParityMatched {
		return Failure(ErrorConflict, "record CAS, transition, or immutable binding validation failed: "+evaluation.MismatchCode, nil)
	}
	previousRecord, err := governance.ValidateCanonicalRecordBytes(previous)
	if err != nil {
		return Failure(ErrorContentInvalid, "stored authority record is invalid", err)
	}
	previousProjection, err := governance.Project(previousRecord)
	if err != nil {
		return Failure(ErrorContentInvalid, "stored authority record projection is invalid", err)
	}
	currentProjection, err := governance.Project(prepared.Record)
	if err != nil {
		return Failure(ErrorContentInvalid, "target authority record projection is invalid", err)
	}
	valid := false
	switch prepared.Operation {
	case OperationClaimExecution:
		valid = prepared.TargetState == governance.StateExecuting && prepared.ExecutionID != ""
	case OperationCompleteExecution:
		valid = prepared.TargetState == governance.StateSucceeded || prepared.TargetState == governance.StateBlocked || prepared.TargetState == governance.StateFailed
	case OperationCancel:
		valid = prepared.TargetState == governance.StateCancelled && prepared.ExecutionID == ""
	case OperationExpire:
		valid = prepared.TargetState == governance.StateExpired && prepared.ExecutionID == "" &&
			shadowstore.TimestampAtOrAfter(currentProjection.UpdatedAt, previousProjection.ExpiresAt)
	case OperationRequireReconciliation:
		valid = prepared.TargetState == governance.StateReconciliationRequired && prepared.ExecutionID != ""
	}
	if !valid {
		return Failure(ErrorConflict, "operation does not bind the requested target state and execution", nil)
	}
	return nil
}

func RequestFingerprint(method, path string, prepared PreparedRequest) string {
	digest := sha256.New()
	_, _ = digest.Write([]byte(method + "\n" + path + "\n" + prepared.CallerID + "\n" + prepared.WorkspaceID + "\n" + strconv.FormatInt(prepared.Route.RoutingEpoch, 10) + "\n" + prepared.ExpectedServiceBuild + "\n"))
	_, _ = digest.Write(prepared.ExactBody)
	return "sha256:" + hex.EncodeToString(digest.Sum(nil))
}

func RequestPath(operation Operation, planID string) string {
	if operation == OperationAccept {
		return "/v1/governance/plans:accept"
	}
	name := map[Operation]string{
		OperationClaimExecution:        "claim-execution",
		OperationCompleteExecution:     "complete-execution",
		OperationCancel:                "cancel",
		OperationExpire:                "expire",
		OperationRequireReconciliation: "require-reconciliation",
	}[operation]
	if name == "" || !planIDPattern.MatchString(planID) {
		return ""
	}
	return "/v1/governance/plans/" + planID + ":" + name
}

func ExpectedIdempotencyKey(exactBody []byte) string {
	digest := sha256.Sum256(exactBody)
	return IdempotencyPrefix + hex.EncodeToString(digest[:])
}

func ValidateIdempotencyKey(value string) error {
	if !idempotencyPattern.MatchString(value) {
		return Failure(ErrorInputInvalid, "Idempotency-Key is not a bounded authority key", nil)
	}
	return nil
}

func ValidateReadIdentity(workspaceID, planID string) error {
	if !identifierPattern.MatchString(workspaceID) || !planIDPattern.MatchString(planID) {
		return Failure(ErrorInputInvalid, "authority read identity is invalid", nil)
	}
	return nil
}

func ValidateReceiptIdentity(workspaceID, key string) error {
	if !identifierPattern.MatchString(workspaceID) {
		return Failure(ErrorInputInvalid, "authority receipt workspace is invalid", nil)
	}
	return ValidateIdempotencyKey(key)
}

func ValidatePendingAuditIdentity(workspaceID, planID string, revision int64) error {
	if err := ValidateReadIdentity(workspaceID, planID); err != nil || revision < 1 || revision > maxSafeInteger {
		return Failure(ErrorInputInvalid, "pending authority audit identity is invalid", err)
	}
	return nil
}

func PrepareAudit(body []byte, callerID, workspaceID, planID, revisionText, routingEpoch, expectedBuild string) (PreparedAudit, error) {
	if len(body) == 0 || len(body) > MaxRequestBytes || !identifierPattern.MatchString(callerID) ||
		!identifierPattern.MatchString(workspaceID) || !planIDPattern.MatchString(planID) || !hashPattern.MatchString(expectedBuild) {
		return PreparedAudit{}, Failure(ErrorInputInvalid, "authority audit request identity is invalid", nil)
	}
	epoch, err := parseRoutingEpoch(routingEpoch)
	if err != nil {
		return PreparedAudit{}, Failure(ErrorInputInvalid, "authority audit routing epoch is invalid", err)
	}
	revision, err := strconv.ParseInt(revisionText, 10, 64)
	if err != nil || revision < 1 || revision > maxSafeInteger || strconv.FormatInt(revision, 10) != revisionText {
		return PreparedAudit{}, Failure(ErrorInputInvalid, "authority audit revision is invalid", err)
	}
	value, err := canonicaljson.Parse(body, canonicaljson.Limits{MaxDepth: governance.MaxDepth + 2, MaxNodes: governance.MaxNodes + 32, MaxStringLength: governance.MaxStringBytes})
	if err != nil {
		return PreparedAudit{}, Failure(ErrorContentInvalid, "parse strict authority audit JSON", err)
	}
	encoded, err := canonicaljson.Encode(value)
	if err != nil || !bytes.Equal(append(encoded, '\n'), body) {
		return PreparedAudit{}, Failure(ErrorContentInvalid, "audit is not exact canonical JSON plus LF", err)
	}
	event, err := governance.ValidateAuditJSON(body)
	if err != nil || event.WorkspaceID != workspaceID || event.PlanID != planID || int64(event.Revision) != revision {
		return PreparedAudit{}, Failure(ErrorContentInvalid, "audit event does not bind the authority transition", err)
	}
	digest := sha256.Sum256(body)
	return PreparedAudit{CallerID: callerID, WorkspaceID: workspaceID, PlanID: planID, Revision: revision,
		RoutingEpoch: epoch, ExpectedServiceBuild: expectedBuild, Event: event,
		ExactBody: append([]byte(nil), body...), EventHash: hex.EncodeToString(digest[:])}, nil
}

func AuditRequestFingerprint(method, path string, prepared PreparedAudit) string {
	digest := sha256.New()
	_, _ = digest.Write([]byte(method + "\n" + path + "\n" + prepared.CallerID + "\n" + prepared.WorkspaceID + "\n" + strconv.FormatInt(prepared.RoutingEpoch, 10) + "\n" + prepared.ExpectedServiceBuild + "\n"))
	_, _ = digest.Write(prepared.ExactBody)
	return "sha256:" + hex.EncodeToString(digest.Sum(nil))
}

func AuditRequestPath(planID string, revision int64) string {
	if !planIDPattern.MatchString(planID) || revision < 1 || revision > maxSafeInteger {
		return ""
	}
	return fmt.Sprintf("/v1/governance/plans/%s/authority-events/%d:record", planID, revision)
}

func PendingAuditRequestPath(planID string, revision int64) string {
	if !planIDPattern.MatchString(planID) || revision < 1 || revision > maxSafeInteger {
		return ""
	}
	return fmt.Sprintf("/v1/governance/plans/%s/authority-events/%d:pending", planID, revision)
}

func ExpectedAuditIdempotencyKey(exactBody []byte) string {
	digest := sha256.Sum256(exactBody)
	return AuditIdempotencyPrefix + hex.EncodeToString(digest[:])
}

func ValidateAuditIdempotencyKey(value string) error {
	if len(value) != len(AuditIdempotencyPrefix)+64 || value[:len(AuditIdempotencyPrefix)] != AuditIdempotencyPrefix || !hashPattern.MatchString(value[len(AuditIdempotencyPrefix):]) {
		return Failure(ErrorInputInvalid, "audit Idempotency-Key is not canonical", nil)
	}
	return nil
}

func validOperation(value Operation) bool {
	switch value {
	case OperationAccept, OperationClaimExecution, OperationCompleteExecution, OperationCancel, OperationExpire, OperationRequireReconciliation:
		return true
	default:
		return false
	}
}

func exactKeys(value canonicaljson.Object, keys []string) bool {
	if len(value) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, ok := value[key]; !ok {
			return false
		}
	}
	return true
}

func stringValue(value canonicaljson.Value) string {
	result, _ := value.(string)
	return result
}

func safeInteger(value canonicaljson.Value, minimum int64) (int64, bool) {
	number, ok := value.(float64)
	if !ok || number < float64(minimum) || number > float64(maxSafeInteger) || number != float64(int64(number)) {
		return 0, false
	}
	return int64(number), true
}

func ParseFingerprint(value string) ([sha256.Size]byte, error) {
	var result [sha256.Size]byte
	if !fingerprintPattern.MatchString(value) {
		return result, Failure(ErrorInputInvalid, "request fingerprint is invalid", nil)
	}
	raw, err := hex.DecodeString(value[len("sha256:"):])
	if err != nil || len(raw) != sha256.Size {
		return result, Failure(ErrorInputInvalid, "request fingerprint is invalid", err)
	}
	copy(result[:], raw)
	return result, nil
}

func FingerprintFromKey(key string) string {
	if !idempotencyPattern.MatchString(key) {
		return ""
	}
	return fmt.Sprintf("sha256:%s", key[len(IdempotencyPrefix):])
}

func parseRoutingEpoch(value string) (int64, error) {
	if value == "" || value[0] == '0' {
		return 0, fmt.Errorf("routing epoch is not canonical positive decimal")
	}
	for _, current := range value {
		if current < '0' || current > '9' {
			return 0, fmt.Errorf("routing epoch is not canonical positive decimal")
		}
	}
	epoch, err := strconv.ParseInt(value, 10, 64)
	if err != nil || epoch < 1 || epoch > maxSafeInteger {
		return 0, fmt.Errorf("routing epoch exceeds the safe integer range")
	}
	return epoch, nil
}
