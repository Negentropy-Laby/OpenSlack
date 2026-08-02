package shadowstore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"reflect"
	"regexp"
	"strconv"
	"time"

	governance "github.com/Negentropy-Laby/OpenSlack/services/governance-control"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/canonicaljson"
)

const maxSafeInteger = int64(9_007_199_254_740_991)

const idempotencyPrefix = "openslack.governance-shadow.v1."

var (
	identifierPattern  = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$`)
	attemptIDPattern   = regexp.MustCompile(`^GCONF-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	hashPattern        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	idempotencyPattern = regexp.MustCompile(`^openslack\.governance-shadow\.v1\.[0-9a-f]{64}$`)
)

var confirmationOutcomes = map[string]struct{}{
	"claim_eligible": {}, "confirmation_rejected": {}, "binding_changed": {},
	"expired": {}, "state_invalid": {}, "execution_active": {},
	"aborted_before_claim": {},
}

type Evaluation struct {
	Parity          Parity
	MismatchCode    string
	ProjectionBytes []byte
	RecordHash      string
}

func ValidateIdempotencyKey(value string) error {
	if !idempotencyPattern.MatchString(value) || len(value) > MaxIdempotencyKeyBytes {
		return Failure(ErrorInputInvalid, "Idempotency-Key is not a bounded canonical value", nil)
	}
	return nil
}

func ExpectedIdempotencyKey(prepared PreparedObservation) string {
	return idempotencyPrefix + hex.EncodeToString(prepared.BodyDigest[:])
}

func ValidateObservationIdempotencyKey(prepared PreparedObservation, value string) error {
	if err := ValidateIdempotencyKey(value); err != nil {
		return err
	}
	if value != ExpectedIdempotencyKey(prepared) {
		return Failure(ErrorInputInvalid, "Idempotency-Key does not bind the exact canonical body", nil)
	}
	return nil
}

// ValidateProjectionIdentity applies the same bounded identities as the
// authoritative observation envelope before either value reaches PostgreSQL.
func ValidateProjectionIdentity(workspaceID, planID string) error {
	if !identifierPattern.MatchString(workspaceID) || !isPlanID(planID) {
		return Failure(ErrorInputInvalid, "projection identity is invalid", nil)
	}
	return nil
}

func PrepareObservation(input []byte) (PreparedObservation, error) {
	if len(input) == 0 || len(input) > MaxObservationBytes {
		return PreparedObservation{}, Failure(ErrorInputInvalid, "observation body exceeds its byte limit", nil)
	}
	value, err := canonicaljson.Parse(input, canonicaljson.Limits{
		MaxDepth: governance.MaxDepth + 6, MaxNodes: governance.MaxNodes + 128,
		MaxStringLength: governance.MaxStringBytes,
	})
	if err != nil {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "parse strict observation JSON", err)
	}
	encoded, err := canonicaljson.Encode(value)
	if err != nil {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "encode canonical observation JSON", err)
	}
	canonical := append(encoded, '\n')
	if !bytes.Equal(canonical, input) {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "observation is not exact canonical JSON plus LF", nil)
	}
	root, ok := value.(canonicaljson.Object)
	if !ok || !hasExactKeys(root, []string{"schema", "authority", "source", "observation"}) {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "observation envelope is not closed", nil)
	}
	if stringValue(root["schema"]) != ObservationSchema || stringValue(root["authority"]) != Authority {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "observation schema or authority is invalid", nil)
	}
	sourceObject, ok := root["source"].(canonicaljson.Object)
	if !ok || !hasExactKeys(sourceObject, []string{"workspaceId", "planId", "sourceSequence"}) {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "observation source is not closed", nil)
	}
	source := Source{
		WorkspaceID: stringValue(sourceObject["workspaceId"]),
		PlanID:      stringValue(sourceObject["planId"]),
	}
	sequence, valid := safeInteger(sourceObject["sourceSequence"], 1)
	if !identifierPattern.MatchString(source.WorkspaceID) || !isPlanID(source.PlanID) || !valid {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "observation source identity is invalid", nil)
	}
	source.SourceSequence = sequence

	observation, ok := root["observation"].(canonicaljson.Object)
	if !ok {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "observation payload must be an object", nil)
	}
	kind := Kind(stringValue(observation["kind"]))
	digest := sha256.Sum256(input)
	prepared := PreparedObservation{Source: source, Kind: kind, ExactBody: append([]byte(nil), input...), BodyDigest: digest}
	switch kind {
	case KindRecord:
		if err := prepareRecord(observation, &prepared); err != nil {
			return PreparedObservation{}, err
		}
	case KindConfirmation:
		if err := prepareConfirmation(observation, &prepared); err != nil {
			return PreparedObservation{}, err
		}
	case KindAudit:
		if err := prepareAudit(observation, &prepared); err != nil {
			return PreparedObservation{}, err
		}
	default:
		return PreparedObservation{}, Failure(ErrorContentInvalid, "observation kind is invalid", nil)
	}
	return prepared, nil
}

func RequestFingerprint(prepared PreparedObservation) string {
	binding := fmt.Sprintf("%s/%s/%s/%d", Authority, prepared.Source.WorkspaceID, prepared.Source.PlanID, prepared.Source.SourceSequence)
	digest := sha256.New()
	_, _ = digest.Write([]byte("POST\n" + ObservationPath + "\n" + binding + "\n"))
	_, _ = digest.Write(prepared.ExactBody)
	return "sha256:" + hex.EncodeToString(digest.Sum(nil))
}

func prepareRecord(value canonicaljson.Object, prepared *PreparedObservation) error {
	if !hasExactKeys(value, []string{"kind", "expectedRevision", "record"}) {
		return Failure(ErrorContentInvalid, "record observation is not closed", nil)
	}
	expected, ok := safeInteger(value["expectedRevision"], 0)
	if !ok {
		return Failure(ErrorContentInvalid, "record expectedRevision is invalid", nil)
	}
	recordObject, ok := value["record"].(canonicaljson.Object)
	if !ok {
		return Failure(ErrorContentInvalid, "record observation has no record object", nil)
	}
	recordBytes, err := canonicaljson.Encode(recordObject)
	if err != nil {
		return Failure(ErrorContentInvalid, "encode observed record", err)
	}
	recordBytes = append(recordBytes, '\n')
	record, err := governance.ValidateCanonicalRecordBytes(recordBytes)
	if err != nil {
		return Failure(ErrorContentInvalid, "validate observed record", err)
	}
	projection, err := governance.Project(record)
	if err != nil {
		return Failure(ErrorContentInvalid, "project observed record", err)
	}
	if projection.PlanID != prepared.Source.PlanID || projection.WorkspaceID != prepared.Source.WorkspaceID {
		return Failure(ErrorContentInvalid, "observed record does not bind its source", nil)
	}
	prepared.ExpectedRevision = expected
	prepared.RecordRevision = int64(projection.Revision)
	prepared.Record = record
	prepared.RecordBytes = recordBytes
	digest := sha256.Sum256(recordBytes)
	prepared.RecordHash = hex.EncodeToString(digest[:])
	return nil
}

func prepareConfirmation(value canonicaljson.Object, prepared *PreparedObservation) error {
	required := []string{"kind", "attemptId", "recordRevision", "attemptedAt", "actorId", "workspaceId", "presentedTokenHash", "authorityOutcome"}
	if !hasRequiredOptionalKeys(value, required, []string{"currentBindings"}) {
		return Failure(ErrorContentInvalid, "confirmation observation is not closed", nil)
	}
	revision, ok := safeInteger(value["recordRevision"], 1)
	confirmation := &Confirmation{
		AttemptID: stringValue(value["attemptId"]), RecordRevision: revision,
		AttemptedAt: stringValue(value["attemptedAt"]), ActorID: stringValue(value["actorId"]),
		WorkspaceID: stringValue(value["workspaceId"]), PresentedTokenHash: stringValue(value["presentedTokenHash"]),
		AuthorityOutcome: stringValue(value["authorityOutcome"]),
	}
	if !ok || !attemptIDPattern.MatchString(confirmation.AttemptID) ||
		!identifierPattern.MatchString(confirmation.ActorID) || !identifierPattern.MatchString(confirmation.WorkspaceID) ||
		!hashPattern.MatchString(confirmation.PresentedTokenHash) || !validTimestamp(confirmation.AttemptedAt) {
		return Failure(ErrorContentInvalid, "confirmation observation fields are invalid", nil)
	}
	if _, exists := confirmationOutcomes[confirmation.AuthorityOutcome]; !exists {
		return Failure(ErrorContentInvalid, "confirmation authorityOutcome is invalid", nil)
	}
	if raw, exists := value["currentBindings"]; exists {
		bindings, ok := raw.(canonicaljson.Object)
		keys := []string{"sourceVersionHash", "permissionSnapshotHash", "actionCatalogHash", "executorBindingHash", "buildNonceHash", "processNonceHash"}
		if !ok || !hasExactKeys(bindings, keys) {
			return Failure(ErrorContentInvalid, "currentBindings is not closed", nil)
		}
		current := &CurrentBindings{
			SourceVersionHash: stringValue(bindings["sourceVersionHash"]), PermissionSnapshotHash: stringValue(bindings["permissionSnapshotHash"]),
			ActionCatalogHash: stringValue(bindings["actionCatalogHash"]), ExecutorBindingHash: stringValue(bindings["executorBindingHash"]),
			BuildNonceHash: stringValue(bindings["buildNonceHash"]), ProcessNonceHash: stringValue(bindings["processNonceHash"]),
		}
		for _, hash := range []string{current.SourceVersionHash, current.PermissionSnapshotHash, current.ActionCatalogHash, current.ExecutorBindingHash, current.BuildNonceHash, current.ProcessNonceHash} {
			if !hashPattern.MatchString(hash) {
				return Failure(ErrorContentInvalid, "currentBindings contains an invalid hash", nil)
			}
		}
		confirmation.CurrentBindings = current
	}
	requiresCurrentBindings := confirmation.AuthorityOutcome == "claim_eligible" ||
		confirmation.AuthorityOutcome == "binding_changed" || confirmation.AuthorityOutcome == "aborted_before_claim"
	if requiresCurrentBindings != (confirmation.CurrentBindings != nil) {
		return Failure(ErrorContentInvalid, "confirmation currentBindings presence does not match authorityOutcome", nil)
	}
	prepared.RecordRevision = revision
	prepared.Confirmation = confirmation
	return nil
}

func prepareAudit(value canonicaljson.Object, prepared *PreparedObservation) error {
	if !hasExactKeys(value, []string{"kind", "recordRevision", "recordHash", "event"}) {
		return Failure(ErrorContentInvalid, "audit observation is not closed", nil)
	}
	revision, ok := safeInteger(value["recordRevision"], 1)
	recordHash := stringValue(value["recordHash"])
	eventObject, eventOK := value["event"].(canonicaljson.Object)
	if !ok || !hashPattern.MatchString(recordHash) || !eventOK {
		return Failure(ErrorContentInvalid, "audit observation binding is invalid", nil)
	}
	eventBytes, err := canonicaljson.Encode(eventObject)
	if err != nil {
		return Failure(ErrorContentInvalid, "encode observed audit event", err)
	}
	eventBytes = append(eventBytes, '\n')
	event, err := governance.ValidateAuditJSON(eventBytes)
	if err != nil {
		return Failure(ErrorContentInvalid, "validate observed audit event", err)
	}
	if event.PlanID != prepared.Source.PlanID || event.WorkspaceID != prepared.Source.WorkspaceID || int64(event.Revision) != revision {
		return Failure(ErrorContentInvalid, "audit event does not bind its source and revision", nil)
	}
	prepared.RecordRevision = revision
	prepared.RecordHash = recordHash
	prepared.Audit = &event
	prepared.AuditBytes = eventBytes
	return nil
}

func EvaluateRecord(prepared PreparedObservation, previous []byte) Evaluation {
	projection, _ := governance.Project(prepared.Record)
	result := Evaluation{Parity: ParityMatched, RecordHash: prepared.RecordHash, ProjectionBytes: encodeProjection(readModelValue(projection))}
	if len(previous) == 0 {
		if prepared.ExpectedRevision != 0 || prepared.RecordRevision != 1 || projection.State != governance.StatePending {
			return mismatch(result, "record_initial_state_invalid")
		}
		return result
	}
	previousRecord, err := governance.ValidateCanonicalRecordBytes(previous)
	if err != nil {
		return mismatch(result, "stored_record_invalid")
	}
	previousProjection, err := governance.Project(previousRecord)
	if err != nil || prepared.ExpectedRevision != int64(previousProjection.Revision) || prepared.RecordRevision != int64(previousProjection.Revision+1) {
		return mismatch(result, "record_revision_mismatch")
	}
	if !governance.CanTransition(previousProjection.State, projection.State) {
		return mismatch(result, "record_transition_invalid")
	}
	previousRoot, _ := parseObject(previous)
	currentRoot, _ := parseObject(prepared.RecordBytes)
	for _, key := range []string{"planId", "createdAt", "expiresAt", "canonicalPlan", "bindings", "confirmationTokenHash"} {
		if !reflect.DeepEqual(previousRoot[key], currentRoot[key]) {
			return mismatch(result, "record_immutable_binding_drift")
		}
	}
	if !timestampNondecreasing(stringValue(previousRoot["updatedAt"]), stringValue(currentRoot["updatedAt"])) {
		return mismatch(result, "record_updated_at_regressed")
	}
	if previousProjection.State == governance.StateExecuting {
		previousExecution, previousOK := previousRoot["execution"].(canonicaljson.Object)
		currentExecution, currentOK := currentRoot["execution"].(canonicaljson.Object)
		if !previousOK || !currentOK {
			return mismatch(result, "record_execution_binding_drift")
		}
		for _, key := range []string{"executionId", "startedAt", "ownerPid"} {
			if !reflect.DeepEqual(previousExecution[key], currentExecution[key]) {
				return mismatch(result, "record_execution_binding_drift")
			}
		}
	}
	return result
}

func EvaluateConfirmation(prepared PreparedObservation, recordBytes []byte) Evaluation {
	result := Evaluation{Parity: ParityMatched}
	record, err := governance.ValidateCanonicalRecordBytes(recordBytes)
	if err != nil {
		return mismatch(result, "confirmation_record_missing_or_invalid")
	}
	projection, _ := governance.Project(record)
	root, _ := parseObject(recordBytes)
	bindings, _ := root["bindings"].(canonicaljson.Object)
	confirmation := prepared.Confirmation
	recomputed := "claim_eligible"
	if projection.Revision != int(confirmation.RecordRevision) || projection.PlanID != prepared.Source.PlanID ||
		projection.WorkspaceID != confirmation.WorkspaceID || projection.ActorID != confirmation.ActorID ||
		!governance.OpaqueHashesEqual(stringValue(root["confirmationTokenHash"]), confirmation.PresentedTokenHash) {
		recomputed = "confirmation_rejected"
	} else if projection.State == governance.StateExecuting {
		recomputed = "execution_active"
	} else if projection.State != governance.StatePending {
		recomputed = "state_invalid"
	} else if expiredAt(projection.ExpiresAt, confirmation.AttemptedAt) {
		recomputed = "expired"
	} else if confirmation.CurrentBindings != nil && !bindingsMatch(bindings, *confirmation.CurrentBindings) {
		recomputed = "binding_changed"
	}
	authority := confirmation.AuthorityOutcome
	matched := authority == recomputed || authority == "aborted_before_claim" && recomputed == "claim_eligible"
	result.ProjectionBytes = encodeProjection(canonicaljson.Object{
		"schema": "openslack.governance_shadow_confirmation_projection.v1", "attemptId": confirmation.AttemptID,
		"planId": prepared.Source.PlanID, "recordRevision": float64(confirmation.RecordRevision),
		"authorityOutcome": authority, "recomputedOutcome": recomputed, "matched": matched,
	})
	if !matched {
		return mismatch(result, "confirmation_outcome_mismatch")
	}
	return result
}

func EvaluateAudit(prepared PreparedObservation, recordBytes []byte) Evaluation {
	result := Evaluation{Parity: ParityMatched, RecordHash: prepared.RecordHash}
	digest := sha256.Sum256(recordBytes)
	if hex.EncodeToString(digest[:]) != prepared.RecordHash {
		return mismatch(result, "audit_record_hash_mismatch")
	}
	record, err := governance.ValidateCanonicalRecordBytes(recordBytes)
	if err != nil {
		return mismatch(result, "audit_record_missing_or_invalid")
	}
	projection, _ := governance.Project(record)
	event := prepared.Audit
	matched := projection.PlanID == event.PlanID && projection.Kind == event.Kind && projection.ActorID == event.ActorID &&
		projection.WorkspaceID == event.WorkspaceID && projection.CorrelationID == event.CorrelationID &&
		projection.State == event.State && projection.Revision == event.Revision && auditTypeAllowed(event.Type, projection)
	if matched {
		recordRoot, _ := parseObject(recordBytes)
		eventRoot, _ := parseObject(prepared.AuditBytes)
		matched = reflect.DeepEqual(expectedEvidenceRefs(recordRoot), event.EvidenceRefs) && auditDetailsMatch(event.Type, recordRoot, eventRoot, projection)
	}
	result.ProjectionBytes = encodeProjection(canonicaljson.Object{
		"schema": "openslack.governance_shadow_audit_projection.v1", "eventId": event.EventID,
		"type": event.Type, "planId": event.PlanID, "revision": float64(event.Revision),
		"state": string(event.State), "evidenceRefCount": float64(len(event.EvidenceRefs)), "matched": matched,
	})
	if !matched {
		return mismatch(result, "audit_projection_mismatch")
	}
	return result
}

func auditDetailsMatch(eventType string, recordRoot, eventRoot canonicaljson.Object, record governance.ReadModel) bool {
	rawDetails, detailsPresent := eventRoot["details"]
	details, detailsObject := rawDetails.(canonicaljson.Object)
	switch eventType {
	case "plan.previewed":
		return detailsObject && hasExactKeys(details, []string{"planHash", "actionCount", "effectCount"}) &&
			stringValue(details["planHash"]) == record.PlanHash && integerEquals(details["actionCount"], record.ActionCount) &&
			integerEquals(details["effectCount"], record.EffectCount)
	case "plan.confirmed":
		return detailsObject && hasExactKeys(details, []string{"executionId"}) && record.Execution != nil &&
			stringValue(details["executionId"]) == record.Execution.ExecutionID
	case "plan.confirmation_rejected":
		if !detailsPresent {
			return true
		}
		return detailsObject && hasExactKeys(details, []string{"reason"}) && stringValue(details["reason"]) == "binding_changed"
	case "workflow.approval_decided":
		if !detailsObject || !hasExactKeys(details, []string{"decision"}) {
			return false
		}
		plan, ok := recordRoot["canonicalPlan"].(canonicaljson.Object)
		if !ok {
			return false
		}
		input, ok := plan["input"].(canonicaljson.Object)
		return ok && reflect.DeepEqual(details["decision"], input["decision"])
	default:
		return !detailsPresent
	}
}

func integerEquals(value canonicaljson.Value, expected int) bool {
	number, ok := value.(float64)
	return ok && number == float64(expected)
}

func mismatch(value Evaluation, code string) Evaluation {
	value.Parity = ParityMismatched
	value.MismatchCode = code
	return value
}

func auditTypeAllowed(eventType string, record governance.ReadModel) bool {
	switch eventType {
	case "plan.previewed":
		return record.State == governance.StatePending && record.Revision == 1
	case "plan.confirmed", "plan.execution_started":
		return record.State == governance.StateExecuting
	case "plan.confirmation_rejected":
		return true
	case "plan.cancelled":
		return record.State == governance.StateCancelled
	case "plan.expired":
		return record.State == governance.StateExpired
	case "plan.execution_completed":
		return record.State == governance.StateSucceeded
	case "plan.execution_blocked":
		return record.State == governance.StateBlocked
	case "plan.execution_failed":
		return record.State == governance.StateFailed
	case "plan.reconciliation_required":
		return record.State == governance.StateReconciliationRequired
	case "workflow.approval_decided":
		return record.State == governance.StateSucceeded && record.Kind == "workflow.approval.decide"
	default:
		return false
	}
}

func expectedEvidenceRefs(root canonicaljson.Object) []string {
	execution, ok := root["execution"].(canonicaljson.Object)
	if !ok {
		return []string{}
	}
	outcomes, ok := execution["outcomes"].(canonicaljson.Array)
	if !ok {
		return []string{}
	}
	refs := []string{}
	for _, rawOutcome := range outcomes {
		outcome, ok := rawOutcome.(canonicaljson.Object)
		if !ok {
			continue
		}
		rawRefs, _ := outcome["evidenceRefs"].(canonicaljson.Array)
		for _, raw := range rawRefs {
			if value, ok := raw.(string); ok {
				refs = append(refs, value)
			}
		}
	}
	return refs
}

func bindingsMatch(root canonicaljson.Object, current CurrentBindings) bool {
	pairs := map[string]string{
		"sourceVersionHash": current.SourceVersionHash, "permissionSnapshotHash": current.PermissionSnapshotHash,
		"actionCatalogHash": current.ActionCatalogHash, "executorBindingHash": current.ExecutorBindingHash,
		"buildNonceHash": current.BuildNonceHash, "processNonceHash": current.ProcessNonceHash,
	}
	for key, expected := range pairs {
		if !governance.OpaqueHashesEqual(stringValue(root[key]), expected) {
			return false
		}
	}
	return true
}

func readModelValue(value governance.ReadModel) canonicaljson.Object {
	result := canonicaljson.Object{
		"schema": value.Schema, "planId": value.PlanID, "revision": float64(value.Revision), "state": string(value.State),
		"kind": value.Kind, "goal": value.Goal, "actorId": value.ActorID, "workspaceId": value.WorkspaceID,
		"correlationId": value.CorrelationID, "createdAt": value.CreatedAt, "updatedAt": value.UpdatedAt, "expiresAt": value.ExpiresAt,
		"actionCount": float64(value.ActionCount), "effectCount": float64(value.EffectCount), "inputHash": value.InputHash,
		"planHash": value.PlanHash, "confirmationBound": value.ConfirmationBound, "executionTerminal": value.ExecutionTerminal,
		"final": value.Final, "reconciliationRequired": value.ReconciliationRequired,
	}
	if value.Execution != nil {
		execution := canonicaljson.Object{
			"executionId": value.Execution.ExecutionID, "startedAt": value.Execution.StartedAt,
			"outcomeCount": float64(value.Execution.OutcomeCount), "evidenceRefCount": float64(value.Execution.EvidenceRefCount),
		}
		if value.Execution.CompletedAt != "" {
			execution["completedAt"] = value.Execution.CompletedAt
		}
		if value.Execution.Blocker != "" {
			execution["blocker"] = value.Execution.Blocker
		}
		if value.Execution.Failure != "" {
			execution["failure"] = value.Execution.Failure
		}
		result["execution"] = execution
	}
	return result
}

func encodeProjection(value canonicaljson.Object) []byte {
	encoded, err := canonicaljson.Encode(value)
	if err != nil {
		return nil
	}
	return append(encoded, '\n')
}

func parseObject(input []byte) (canonicaljson.Object, error) {
	value, err := canonicaljson.Parse(input, canonicaljson.Limits{MaxDepth: governance.MaxDepth + 2, MaxNodes: governance.MaxNodes + 16, MaxStringLength: governance.MaxStringBytes})
	if err != nil {
		return nil, err
	}
	root, ok := value.(canonicaljson.Object)
	if !ok {
		return nil, fmt.Errorf("value is not an object")
	}
	return root, nil
}

func validTimestamp(value string) bool {
	_, ok := parseECMAScriptTimestamp(value)
	return ok
}

func expiredAt(expiresAt, attemptedAt string) bool {
	expires, expiresOK := parseECMAScriptTimestamp(expiresAt)
	attempted, attemptedOK := parseECMAScriptTimestamp(attemptedAt)
	return expiresOK && attemptedOK && !attempted.Before(expires)
}

func timestampNondecreasing(previous, current string) bool {
	previousTime, previousOK := parseECMAScriptTimestamp(previous)
	currentTime, currentOK := parseECMAScriptTimestamp(current)
	return previousOK && currentOK && !currentTime.Before(previousTime)
}

// parseECMAScriptTimestamp mirrors the frozen governed-plan validator.
// time.Date supplies ECMAScript-compatible normalization for values such as
// February 31 and 24:00:00.000 that the TypeScript authority accepts.
func parseECMAScriptTimestamp(value string) (time.Time, bool) {
	if len(value) != 24 || value[4] != '-' || value[7] != '-' || value[10] != 'T' ||
		value[13] != ':' || value[16] != ':' || value[19] != '.' || value[23] != 'Z' {
		return time.Time{}, false
	}
	indices := [7][2]int{{0, 4}, {5, 7}, {8, 10}, {11, 13}, {14, 16}, {17, 19}, {20, 23}}
	parts := [7]int{}
	for index, bounds := range indices {
		part, err := strconv.Atoi(value[bounds[0]:bounds[1]])
		if err != nil {
			return time.Time{}, false
		}
		parts[index] = part
	}
	year, month, day, hour, minute, second, millisecond := parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]
	if month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 24 ||
		minute < 0 || minute > 59 || second < 0 || second > 59 || millisecond < 0 || millisecond > 999 ||
		hour == 24 && (minute != 0 || second != 0 || millisecond != 0) {
		return time.Time{}, false
	}
	return time.Date(year, time.Month(month), day, hour, minute, second, millisecond*int(time.Millisecond), time.UTC), true
}

func safeInteger(value canonicaljson.Value, minimum int64) (int64, bool) {
	number, ok := value.(float64)
	if !ok || number < float64(minimum) || number > float64(maxSafeInteger) || number != float64(int64(number)) {
		return 0, false
	}
	return int64(number), true
}

func stringValue(value canonicaljson.Value) string { result, _ := value.(string); return result }

func isPlanID(value string) bool {
	return regexp.MustCompile(`^GPLAN-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(value)
}

func hasExactKeys(value canonicaljson.Object, required []string) bool {
	return hasRequiredOptionalKeys(value, required, nil)
}

func hasRequiredOptionalKeys(value canonicaljson.Object, required, optional []string) bool {
	allowed := make(map[string]struct{}, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = struct{}{}
		if _, ok := value[key]; !ok {
			return false
		}
	}
	for _, key := range optional {
		allowed[key] = struct{}{}
	}
	if len(value) < len(required) || len(value) > len(allowed) {
		return false
	}
	for key := range value {
		if _, ok := allowed[key]; !ok {
			return false
		}
	}
	return true
}

func ParseFingerprint(value string) ([sha256.Size]byte, error) {
	var result [sha256.Size]byte
	if len(value) != len("sha256:")+sha256.Size*2 || value[:len("sha256:")] != "sha256:" {
		return result, Failure(ErrorInputInvalid, "request fingerprint is invalid", nil)
	}
	decoded, err := hex.DecodeString(value[len("sha256:"):])
	if err != nil || len(decoded) != sha256.Size {
		return result, Failure(ErrorInputInvalid, "request fingerprint is invalid", err)
	}
	copy(result[:], decoded)
	return result, nil
}

func DigestString(value [sha256.Size]byte) string { return hex.EncodeToString(value[:]) }

func SourceBinding(value Source) string {
	return Authority + "/" + value.WorkspaceID + "/" + value.PlanID + "/" + strconv.FormatInt(value.SourceSequence, 10)
}
